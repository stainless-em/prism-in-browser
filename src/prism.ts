import { getHttpOperationsFromSpec } from "@stoplight/prism-cli/dist/operations.js";
import {
  createLogger,
  IPrismDiagnostic,
  IPrismOutput,
} from "@stoplight/prism-core";
import {
  IHttpOperationConfig,
  IHttpRequest,
  IHttpResponse,
  UNPROCESSABLE_ENTITY,
  createInstance,
  IHttpConfig,
  IHttpNameValues,
  PickRequired,
  PrismHttpComponents,
  ProblemJsonError,
  VIOLATIONS,
} from "@stoplight/prism-http";
import {
  DiagnosticSeverity,
  Dictionary,
  HttpMethod,
  IHttpOperation,
} from "@stoplight/types";
import { XMLBuilder } from "fast-xml-parser";
import * as E from "fp-ts/lib/Either.js";
import { pipe } from "fp-ts/lib/function.js";
import * as IOE from "fp-ts/lib/IOEither.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import * as D from "io-ts/lib/Decoder.js";
import _fp from "lodash/fp.js";
import parsePreferHeader from "parse-prefer-header";
import { is as typeIs } from "type-is";
const { merge } = _fp;

interface IPrismHttpServerOpts {
  components: PickRequired<Partial<PrismHttpComponents>, "logger">;
  config: IHttpConfig;
}

const xmlSerializer = new XMLBuilder({});

const serializers = [
  {
    test: (value: string) =>
      !!typeIs(value, ["application/json", "application/*+json"]),
    serializer: JSON.stringify,
  },
  {
    test: (value: string) =>
      !!typeIs(value, ["application/xml", "application/*+xml"]),
    serializer: (data: unknown) =>
      typeof data === "string" ? data : xmlSerializer.build({ xml: data }),
  },
  {
    test: (value: string) => !!typeIs(value, ["text/*"]),
    serializer: (data: unknown) => {
      if (["string", "undefined"].includes(typeof data)) {
        return data;
      }

      throw Object.assign(
        new Error("Cannot serialise complex objects as text"),
        {
          detail: "Cannot serialise complex objects as text",
          status: 500,
          name: "https://stoplight.io/prism/errors#NO_COMPLEX_OBJECT_TEXT",
        }
      );
    },
  },
];

const serialize = (payload: unknown, contentType?: string) => {
  if (!contentType && !payload) {
    return;
  }

  const serializer = contentType
    ? serializers.find((s) => s.test(contentType))
    : undefined;

  if (!serializer) {
    if (typeof payload === "string") return payload;

    throw new Error(`Cannot find serializer for ${contentType}`);
  }

  return serializer.serializer(payload);
};

const BooleanFromString = D.parse<string, boolean>((s) =>
  s === "true"
    ? D.success(true)
    : s === "false"
    ? D.success(false)
    : D.failure(s, "a boolean")
);

const IntegerFromString = D.parse<string, number>((s) => {
  return /^\d{3}$/.test(s)
    ? D.success(parseInt(s, 10))
    : D.failure(s, "a number");
});

const PreferencesDecoder = D.partial({
  code: pipe(D.string, IntegerFromString),
  dynamic: pipe(D.string, BooleanFromString),
  example: D.string,
});

type RequestPreferences = Partial<Omit<IHttpOperationConfig, "mediaType">>;

const getHttpConfigFromRequest = (
  req: Pick<IHttpRequest, "headers" | "url">
): E.Either<ProblemJsonError, RequestPreferences> => {
  const preferences: unknown =
    req.headers && req.headers["prefer"]
      ? parsePreferHeader(req.headers["prefer"])
      : {
          code: req.url.query?.__code,
          dynamic: req.url.query?.__dynamic,
          example: req.url.query?.__example,
        };

  return pipe(
    PreferencesDecoder.decode(preferences),
    E.bimap(
      (err) => ProblemJsonError.fromTemplate(UNPROCESSABLE_ENTITY, D.draw(err)),
      (parsed) => ({
        code: parsed?.code,
        exampleKey: parsed?.example,
        dynamic: parsed?.dynamic,
      })
    )
  );
};

function searchParamsToNameValues(
  searchParams: URLSearchParams
): IHttpNameValues {
  const params: IHttpNameValues = {};
  for (const key of searchParams.keys()) {
    const values = searchParams.getAll(key);
    params[key] = values.length === 1 ? values[0] : values;
  }
  return params;
}

type ValidationError = {
  location: string[];
  severity: string;
  code: string | number | undefined;
  message: string | undefined;
};

const MAX_SAFE_HEADER_LENGTH = 8 * 1024 - 100; // 8kb minus some
function addViolationHeader(
  replyHeaders: Headers,
  validationErrors: ValidationError[]
) {
  if (validationErrors.length === 0) {
    return;
  }

  let value = JSON.stringify(validationErrors);
  if (value.length > MAX_SAFE_HEADER_LENGTH) {
    value = `Too many violations! ${value.substring(
      0,
      MAX_SAFE_HEADER_LENGTH
    )}`;
  }

  replyHeaders.set("sl-violations", value);
}

function parseRequestBody(request: Request) {
  // if no body provided then return null instead of empty string
  if (
    // If the body size is null, it means the body itself is null so the promise can resolve with a null value
    request.headers.get("content-length") === "0" ||
    // Per HTTP 1.1 - these 2 headers are the valid way to indicate that a body exists:
    // > The presence of a message body in a request is signaled by a Content-Length or Transfer-Encoding header field.
    // https://httpwg.org/specs/rfc9112.html#message.body
    (request.headers.get("transfer-encoding") === undefined &&
      request.headers.get("content-length") === undefined)
  ) {
    return Promise.resolve(null);
  }

  if (
    typeIs(request.headers.get("content-type")!, [
      "application/json",
      "application/*+json",
    ])
  ) {
    return request.json();
  } else {
    return request.text();
  }
}

const createServer = (
  operations: IHttpOperation[],
  opts: IPrismHttpServerOpts
) => {
  const { components, config } = opts;

  const fetch = async (
    ...args: ConstructorParameters<typeof Request>
  ): Promise<Response> => {
    const request = new Request(...args);
    const { url, method, headers } = request;

    const body = await parseRequestBody(request);

    const { searchParams, pathname } = new URL(
      url!, // url can't be empty for HTTP request
      "http://example.com" // needed because URL can't handle relative URLs
    );

    const input = {
      method: (method ? method.toLowerCase() : "get") as HttpMethod,
      url: {
        path: pathname,
        baseUrl: searchParams.get("__server") || undefined,
        query: searchParamsToNameValues(searchParams),
      },
      headers: Object.fromEntries(headers.entries()),
      body,
    };

    components.logger.info({ input }, "Request received");

    const requestConfig: E.Either<Error, IHttpConfig> = pipe(
      getHttpConfigFromRequest(input),
      E.map((operationSpecificConfig) => ({
        ...config,
        mock: merge(config.mock, operationSpecificConfig),
      }))
    );

    const result: E.Either<never, Response> = await pipe(
      TE.fromEither(requestConfig),
      TE.chain<Error, IHttpConfig, IPrismOutput<IHttpResponse>>(
        (requestConfig) => prism.request(input, operations, requestConfig)
      ),
      TE.chainIOEitherK((response) => {
        const { output } = response;
        const headers = new Headers(output.headers);

        const inputValidationErrors = response.validations.input.map(
          createErrorObjectWithPrefix("request")
        );
        const outputValidationErrors = response.validations.output.map(
          createErrorObjectWithPrefix("response")
        );
        const inputOutputValidationErrors = inputValidationErrors.concat(
          outputValidationErrors
        );

        if (inputOutputValidationErrors.length > 0) {
          addViolationHeader(headers, inputOutputValidationErrors);

          const errorViolations = outputValidationErrors.filter(
            (v) => v.severity === DiagnosticSeverity[DiagnosticSeverity.Error]
          );

          if (opts.config.errors && errorViolations.length > 0) {
            return IOE.left(
              ProblemJsonError.fromTemplate(
                VIOLATIONS,
                "Your request/response is not valid and the --errors flag is set, so Prism is generating this error for you.",
                { validation: errorViolations }
              )
            );
          }
        }

        inputOutputValidationErrors.forEach((validation) => {
          const message = `Violation: ${validation.location.join(".") || ""} ${
            validation.message
          }`;
          if (
            validation.severity === DiagnosticSeverity[DiagnosticSeverity.Error]
          ) {
            components.logger.error({ name: "VALIDATOR" }, message);
          } else if (
            validation.severity ===
            DiagnosticSeverity[DiagnosticSeverity.Warning]
          ) {
            components.logger.warn({ name: "VALIDATOR" }, message);
          } else {
            components.logger.info({ name: "VALIDATOR" }, message);
          }
        });

        return IOE.right(
          new Response(
            serialize(output.body, headers.get("content-type") ?? undefined),
            {
              headers,
              status: output.statusCode,
            }
          )
        );
      }),
      TE.orElse(
        (
          e: Error & {
            status?: number;
            additional?: { headers?: Dictionary<string> };
          }
        ) => {
          const headers = new Headers();
          headers.set("content-type", "application/problem+json");

          if (e.additional && e.additional.headers)
            Object.entries(e.additional.headers).forEach(([name, value]) =>
              headers.set(name, value)
            );

          components.logger.error(
            { input },
            `Request terminated with error: ${e}`
          );
          return TE.right(
            Response.json(ProblemJsonError.toProblemJson(e), {
              status: e.status || 500,
              headers,
            })
          );
        }
      )
    )();
    if (result._tag === "Left") throw new Error("unreachable");
    return result.right;
  };

  const prism = createInstance(config, components);

  return {
    get prism() {
      return prism;
    },
    get logger() {
      return components.logger;
    },
    get fetch() {
      return fetch;
    },
  };
};

const createErrorObjectWithPrefix =
  (locationPrefix: string) => (detail: IPrismDiagnostic) => ({
    location: [locationPrefix].concat(detail.path || []),
    severity: DiagnosticSeverity[detail.severity],
    code: detail.code,
    message: detail.message,
  });

export { createLogger, createServer, getHttpOperationsFromSpec };

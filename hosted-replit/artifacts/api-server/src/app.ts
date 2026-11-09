import express, { type Express } from "express";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import { SupportError } from "./lib/support-config";
import { ZodError } from "zod";
import router from "./routes";
import { logger } from "./lib/logger";
import { correlation, diagnostic, errorCode, requestTracing, serverRequestId } from "./lib/observability";

const app: Express = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    genReqId: serverRequestId,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(requestTracing);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(clerkMiddleware((req) => ({
  publishableKey: publishableKeyFromHost(getClerkProxyHost(req) ?? "", process.env.CLERK_PUBLISHABLE_KEY),
})));

app.use("/api", router);
app.use(((error, req, res, _next) => {
  const status = error instanceof SupportError ? error.status : error instanceof ZodError ? 400 : 500;
  diagnostic({ event: "http_request_error", statusCode: status, errorCode: errorCode(error) });
  res.status(status).json({ error: error instanceof SupportError ? error.message : status === 400 ? "Please check the submitted information." : "The service is temporarily unavailable. Please retry.", correlation: correlation() });
}) as express.ErrorRequestHandler);

export default app;

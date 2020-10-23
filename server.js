import * as Environment from "~/node_common/environment";
import * as ScriptLogging from "~/node_common/script-logging";

import APIRouteIndex from "~/pages";
import APIRouteUpload from "~/pages/upload";

import express from "express";
import cors from "cors";
import morgan from "morgan";
import compression from "compression";

const server = express();

server.use(cors());
server.use(morgan(":method :url :status :res[content-length] - :response-time ms"));
server.get("/favicon.ico", (req, res) => res.status(204));

server.get("/", async (req, res) => {
  return await APIRouteIndex(req, res);
});

server.post("/api/data/:upload", async (req, res) => {
  req.setTimeout(0);

  return await APIRouteUpload(req, res);
});

server.post("/api/deal/:upload", async (req, res) => {
  req.setTimeout(0);

  return await APIRouteUpload(req, res, { bucketName: "stage-deal" });
});

const listenServer = server.listen(Environment.PORT, (e) => {
  if (e) throw e;

  ScriptLogging.taskTimeless(`live on http://localhost:${Environment.PORT}`);
});

listenServer.headersTimeout = 0;

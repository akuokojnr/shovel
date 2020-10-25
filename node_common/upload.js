import * as LibraryManager from "~/node_common/managers/library";
import * as Utilities from "~/node_common/utilities";
import * as Social from "~/node_common/social";
import * as Strings from "~/common/strings";
import * as Logs from "~/node_common/script-logging";
import * as NodeConstants from "~/node_common/constants";

import Throttle from "~/node_common/vendor/throttle";
import AbortController from "abort-controller";
import BusBoyConstructor from "busboy";
import Queue from "p-queue";

const WORKER_NAME = "BROWSER->RENDER->TEXTILE";
const HIGH_WATER_MARK = 1024 * 1024 * 3;

export async function formMultipart(req, res, { user, bucketName, originalFileName }) {
  console.log("\n\n\n");

  const singleConcurrencyQueue = new Queue({ concurrency: 1 });
  const controller = new AbortController();
  const heapSize = Strings.bytesToSize(process.memoryUsage().heapUsed);
  const uploadSizeBytes = req.headers["content-length"];
  const timeoutMap = {};

  const { signal } = controller;

  let data = null;
  let dataPath = null;

  Logs.taskTimeless(`${user.username} is pushing ${originalFileName}`, WORKER_NAME);
  Logs.note(`heap size : ${heapSize}`);
  Logs.note(`upload size  : ${Strings.bytesToSize(uploadSizeBytes)}`);

  if (uploadSizeBytes > NodeConstants.TEXTILE_BUCKET_LIMIT) {
    return {
      decorator: "UPLOAD_SIZE_TOO_LARGE",
      error: true,
    };
  }

  let { buckets, bucketKey, bucketRoot } = await Utilities.getBucketAPIFromUserToken({
    user,
    bucketName,
  });

  if (!buckets) {
    Logs.error("Utilities.getBucketAPIFromUserToken()");
    return {
      decorator: "UPLOAD_NO_BUCKETS",
      error: true,
      message: `No buckets for ${user.username}.`,
    };
  }

  let bucketSizeBytes = null;
  try {
    const path = await buckets.listPath(bucketKey, "/");
    bucketSizeBytes = path.item.size;
  } catch (e) {
    return {
      decorator: "UPLOAD_BUCKET_CHECK_FAILED",
      error: true,
    };
  }

  let remainingSizeBytes = NodeConstants.TEXTILE_BUCKET_LIMIT - bucketSizeBytes;
  Logs.note(`bucket size bytes : ${bucketSizeBytes}`);
  Logs.note(`remaining size bytes : ${remainingSizeBytes}`);

  if (uploadSizeBytes > remainingSizeBytes) {
    return {
      decorator: "UPLOAD_NOT_ENOUGH_SPACE_REMAINS",
      error: true,
    };
  }

  const busboy = new BusBoyConstructor({
    headers: req.headers,
    highWaterMark: HIGH_WATER_MARK,
  });

  const _createStreamAndUploadToTextile = async (writableStream) => {
    return new Promise(function(resolvePromiseFn, rejectPromiseFn) {
      function _safeForcedSingleConcurrencyFn(actionFn, rejectFn, timeoutId) {
        singleConcurrencyQueue.add(async function() {
          try {
            await actionFn();
          } catch (e) {
            Logs.error(`${timeoutId} : queue.pause()`);
            singleConcurrencyQueue.pause();

            Logs.error(`${timeoutId} : controller.abort()`);
            controller.abort();

            Logs.error(`${timeoutId} : sendTextileSlackMessage()`);
            Social.sendTextileSlackMessage({
              file: "/node_common/upload.js",
              user,
              message: e.message,
              code: e.code,
              functionName: `${timeoutId} : _safeForcedSingleConcurrencyFn()`,
            });

            Logs.error(`${timeoutId} : req.unpipe()`);
            req.unpipe();

            Logs.error(`${timeoutId} : rejectFn() of safeForcedSingleConcurrencyFn()`);

            return rejectFn({
              decorator: "UPLOAD_FAILURE",
              error: true,
              message: e.message,
              id: timeoutId,
            });
          }
        });
      }

      // NOTE(jim)
      //
      // stream    - ReadableStream constructor
      // mime      - */* file type
      // filename  - filename reference for extension later.
      //
      //
      writableStream.on("file", function(fieldname, stream, filename, encoding, mime) {
        const timeoutId = `${user.username}-${filename}`;

        data = LibraryManager.createLocalDataIncomplete({
          name: filename,
          type: mime,
        });

        return _safeForcedSingleConcurrencyFn(
          async () => {
            let push = await buckets
              .pushPath(bucketKey, data.id, stream, {
                root: bucketRoot,
                signal,
                progress: function(num) {
                  if (num % (HIGH_WATER_MARK * 5) !== 0) {
                    return;
                  }

                  Logs.note(`${timeoutId} : ${Strings.bytesToSize(num)}`);
                },
              })
              .catch(function(e) {
                throw new Error(e.message);
              });

            dataPath = push.path.path;

            req.unpipe();
            Logs.task(`${timeoutId} : req.unpipe()`, WORKER_NAME);
          },
          rejectPromiseFn,
          timeoutId
        );
      });

      writableStream.on("finish", function() {
        return _safeForcedSingleConcurrencyFn(() => {
          Logs.task("busboy finished");

          if (Strings.isEmpty(dataPath)) {
            return rejectPromiseFn({
              decorator: "UPLOAD_FAILURE",
              error: true,
              message: "Missing Textile URL data.",
            });
          }

          Logs.task(dataPath, WORKER_NAME);

          return resolvePromiseFn({
            decorator: "UPLOAD_STREAM_SUCCESS",
            data: dataPath,
          });
        }, rejectPromiseFn);
      });

      writableStream.on("error", function(e) {
        return _safeForcedSingleConcurrencyFn(() => {
          throw new Error(e.message);
        }, rejectPromiseFn);
      });

      Logs.task("req.pipe(writableStream)", WORKER_NAME);
      req.pipe(writableStream);
    });
  };

  let response = null;
  try {
    response = await _createStreamAndUploadToTextile(busboy);
  } catch (e) {
    Logs.error(e.message);
    res.set("Connection", "close");

    return response;
  }

  Logs.task("response", WORKER_NAME);
  console.log(response);

  if (response && response.error) {
    res.set("Connection", "close");

    return response;
  }

  Logs.note("non-essential Utilities.getBucketAPIFromuserToken()");
  let refreshed = await Utilities.getBucketAPIFromUserToken({
    user,
    bucketName,
  });

  if (!refreshed.buckets) {
    Logs.error("Utilities.getBucketAPIFromuserToken() failed");
    return {
      decorator: "UPLOAD_FAILURE",
      error: true,
    };
  }

  try {
    const newUpload = await refreshed.buckets.listIpfsPath(response.data);
    data.size = newUpload.size;

    Logs.task(`${data.name} : ${Strings.bytesToSize(data.size)} uploaded`, WORKER_NAME);
  } catch (e) {
    Social.sendTextileSlackMessage({
      file: "/node_common/upload.js",
      user,
      message: e.message,
      code: e.code,
      functionName: `refreshed.buckets.listIpfsPath`,
    });

    return {
      decorator: "UPLOAD_VERIFY_FAILURE",
      error: true,
      message: e.message,
    };
  }

  Logs.task(`SUCCESS !!!`, WORKER_NAME);
  return { decorator: "UPLOAD_SUCCESS", data, ipfs: response.data };
}

/**
 * What to say when an upload is refused before the route ever runs.
 *
 * multer reports a rejected upload by calling next(err) with a MulterError,
 * which skips the route handler entirely and lands on the app-wide handler in
 * index.js. A MulterError carries no `.status`, so that handler reads it as a
 * 500 and — outside development — replaces the message with "Internal server
 * error". Someone who has just spent four minutes pushing a video up a home
 * upstream link is then told nothing at all about why it failed, and the
 * obvious conclusion is that the app is broken rather than that the file is
 * too big.
 */

const multer = require('multer');
const { error } = require('./apiResponse');
const { MAX_FILE_BYTES, MAX_FILES_PER_REQUEST } = require('./mediaTypes');

const MAX_FILE_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

function uploadErrors(err, req, res, next) {
  // Anything that is not multer's belongs to the app-wide handler: a database
  // failure answered here as a bad request would blame the caller for ours.
  if (!(err instanceof multer.MulterError)) return next(err);

  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      // "a file", not "that file": the error carries the form field name, not
      // the filename, and in a batch of forty there is no honest way to say
      // which one it was.
      return error(res, 413, `A file is larger than the ${MAX_FILE_MB} MB limit`);
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_PART_COUNT':
      return error(res, 400, `Upload at most ${MAX_FILES_PER_REQUEST} files at once`);
    default:
      // multer's own wording for the rest. They describe a malformed request
      // rather than a policy, and are more use than anything paraphrased.
      return error(res, 400, err.message);
  }
}

module.exports = { uploadErrors, MAX_FILE_MB };

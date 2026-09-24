export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (msg) => new HttpError(400, msg);
export const forbidden = (msg) => new HttpError(403, msg);
export const notFound = (msg = '찾을 수 없습니다.') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);

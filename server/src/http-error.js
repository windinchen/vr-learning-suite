// 带 HTTP 状态码的业务错误：后台各处（含课堂模块）都用它，免得各写一份。
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

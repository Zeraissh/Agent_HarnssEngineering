/**
 * 中止位必须能掐掉「已经在 await 里」的工作。
 *
 * SDK / 兼容端点 / 工具经常把 signal 收下却不立刻 reject——于是「停止」
 * 要等这一整轮模型吐完或 bash 跑完，体感就是按钮失灵。
 * 这里用 abort 事件与原 Promise 赛跑：宿主一拉闸，调用方马上收到 AbortError，
 * 后台那趟请求可以自己死，界面不必陪它耗着。
 */

export function abortError(message = "The operation was aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function rejectWhenAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

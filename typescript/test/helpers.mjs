// Stub fetch: records every call and answers from a queue of responses
// (a Response, an Error to throw, or a function of the call).
export function stubFetch(...queue) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = {
      url: new URL(url),
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    };
    calls.push(call);
    let next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "function") next = await next(call);
    if (next instanceof Error) throw next;
    return next ?? json({});
  };
  return { fetch, calls };
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_1", ...headers },
  });

export const apiError = (status, code, message = "Nope.", headers = {}) =>
  json({ error: { code, message, request_id: "req_err" } }, status, headers);

export const noSleep = () => {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
};

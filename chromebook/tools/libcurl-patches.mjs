// The changes PhoneBridge makes to libcurl.js, shared by tools/vendor.mjs (extension) and
// tools/build-page.mjs (single file). Each patch site must occur exactly once.
//
// 1. Null-body statuses. Upstream builds `new Response(stream, {status})` for every status except
//    204/205. The Fetch spec forbids a body on 101/103/304, so a 304 (cache revalidation) hung.
// 2. Event-driven curl loop. Upstream drives curl_multi_perform from setInterval(…, 0): ≥4 ms per
//    step in a foreground tab and ~1 s per step in a background tab, on every TLS round trip.
//    The hook registers each session so PhoneBridge can run perform() the moment tunnel bytes
//    arrive (PB.fetcher.kick). The interval stays as the fallback for curl's own timers.
export const PATCHES = [
  {
    name: 'null-body statuses',
    from: 'if (response_info.status === 204 || response_info.status === 205) {',
    to: 'if ([101, 103, 204, 205, 304].includes(response_info.status)) { /* PhoneBridge patch: null-body statuses */',
  },
  {
    name: 'session registry (event-driven perform)',
    from: '    this.request_callbacks = {};\n    this.last_request_id = 0;\n  }',
    to: '    this.request_callbacks = {};\n    this.last_request_id = 0;\n'
      + '    (globalThis.__pbCurlSessions || (globalThis.__pbCurlSessions = new Set())).add(this); /* PhoneBridge patch */\n  }',
  },
  {
    name: 'session registry cleanup',
    from: '    _session_cleanup(this.session_ptr);\n    this.session_ptr = null;',
    to: '    if (globalThis.__pbCurlSessions) globalThis.__pbCurlSessions.delete(this); /* PhoneBridge patch */\n'
      + '    _session_cleanup(this.session_ptr);\n    this.session_ptr = null;',
  },
];

export function applyPatches(src, label) {
  for (const p of PATCHES) {
    const hits = src.split(p.from).length - 1;
    if (hits !== 1) throw new Error(`${label}: patch "${p.name}" expected its site exactly once, found ${hits}. Re-check the patch.`);
    src = src.replace(p.from, () => p.to);
  }
  return src;
}

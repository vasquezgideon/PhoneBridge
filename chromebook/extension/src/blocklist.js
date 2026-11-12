// PhoneBridge — small built-in ad/tracker blocklist. Every blocked request is bandwidth the
// Bluetooth link doesn't spend. Matches the host and any parent domain.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});

  const DOMAINS = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com',
    'googletagservices.com', 'adservice.google.com', 'pagead2.googlesyndication.com', 'imasdk.googleapis.com',
    'amazon-adsystem.com', 'adnxs.com', 'adsrvr.org', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
    'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com', 'smartadserver.com', 'moatads.com',
    'scorecardresearch.com', 'quantserve.com', 'quantcount.com', 'hotjar.com', 'hotjar.io', 'mixpanel.com',
    'segment.io', 'segment.com', 'fullstory.com', 'newrelic.com', 'nr-data.net', 'branch.io', 'appsflyer.com',
    'adjust.com', 'bat.bing.com', 'ads.linkedin.com', 'analytics.tiktok.com', 'ads-twitter.com', 'static.ads-twitter.com',
    'connect.facebook.net', 'pixel.facebook.com', 'an.facebook.com', 'yieldmo.com', 'teads.tv', 'sharethrough.com',
    '33across.com', 'indexww.com', 'lijit.com', 'media.net', 'contextweb.com', 'bidswitch.net', 'serving-sys.com',
    'zedo.com', 'adform.net', 'everesttech.net', 'demdex.net', 'omtrdc.net', 'krxd.net', 'bluekai.com', 'chartbeat.com',
    'chartbeat.net', 'parsely.com', 'clarity.ms', 'sentry-cdn.com', 'doubleverify.com', 'adsafeprotected.com',
  ];
  const SET = new Set(DOMAINS);

  function isBlocked(url) {
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
    for (let h = host; h; ) {
      if (SET.has(h)) return true;
      const i = h.indexOf('.');
      if (i < 0) break;
      h = h.slice(i + 1);
    }
    return false;
  }

  PB.blocklist = { isBlocked, size: SET.size };
})(typeof window !== 'undefined' ? window : globalThis);

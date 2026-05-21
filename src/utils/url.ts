import {URL} from 'url';

export const cleanUrl = (url: string) => {
  try {
    // Clean URL - remove tracking parameters but keep functional ones (v, list, t)
    const u = new URL(url);
    const trackingParams = new Set(['si', 'pp']); // YouTube tracking parameters

    for (const [name] of u.searchParams) {
      if (trackingParams.has(name)) {
        u.searchParams.delete(name);
      }
    }

    return u.toString();
  } catch (_: unknown) {
    return url;
  }
};

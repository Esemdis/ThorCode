/**
 * Validates a band's Songkick or Bandsintown source url (THO-976).
 *
 * The stored url is what ThorCode sends python-crohn's scraper to. It comes
 * from MusicBrainz, a wiki anyone can edit, and from the admin PATCH. It used
 * to be accepted when the text merely contained "songkick.com", so
 * `https://attacker.example/songkick.com/x` or `http://10.0.0.5/songkick.com`
 * passed: a request from the scraper's network to an address of the editor's
 * choosing, or a page of made-up concerts sent on to followers.
 *
 * So the url is parsed and the *hostname* checked: https only, the site itself
 * or a subdomain of it (a dot before the name, so `notsongkick.com` and
 * `songkick.com.evil.test` fail), no userinfo (`https://songkick.com@evil.test`
 * reads as songkick to a person) and no port. python-crohn applies the same
 * rule again at scrape time (`host_allowed` in services/scrape_browser.py).
 *
 * No dependencies on purpose: findSourceUrls' module must stay prisma-free.
 */

const SOURCE_SITES = Object.freeze({
  songkick: 'songkick.com',
  bandsintown: 'bandsintown.com',
});

/**
 * The cleaned url (origin + path, no query, hash or trailing slash) when `raw`
 * is an https page on `site` or a subdomain of it; otherwise null.
 *
 * @param {unknown} raw
 * @param {string} site e.g. SOURCE_SITES.songkick
 * @returns {string|null}
 */
function sourceUrl(raw, site) {
  if (typeof raw !== 'string' || raw === '') return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.port) return null;
  // URL lower-cases the hostname, so mixed-case hosts compare equal here.
  const host = u.hostname;
  if (host !== site && !host.endsWith(`.${site}`)) return null;
  return `${u.origin}${u.pathname}`.replace(/\/$/, '');
}

module.exports = { sourceUrl, SOURCE_SITES };

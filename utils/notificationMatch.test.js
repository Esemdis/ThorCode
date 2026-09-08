import { describe, it, expect } from 'vitest';
import { subscriptionMatches, matchesByUser } from './notificationMatch.js';

// The shape runNotificationDigest selects, and the shape /wishlists/notify
// re-reads from the database so both paths match against the same fields.
const concert = (id, cityId, bandIds, extra = {}) => ({
  id,
  name: null,
  venue: 'Debaser',
  city: 'Stockholm',
  country: 'SE',
  concert_date: new Date('2026-11-02T19:00:00Z'),
  url: null,
  city_id: cityId,
  bands: bandIds.map((b) => ({ band_rel: { id: b, name: `Band ${b}` } })),
  ...extra,
});

const sub = (userId, bandId, cityId) => ({
  user_id: userId,
  band_id: bandId,
  city_id: cityId,
  user_rel: { id: userId, email: `${userId}@example.com` },
});

const follows = (...bandIds) => new Set(bandIds);

describe('subscriptionMatches', () => {
  it('matches a band-and-city watch only when both the band and the city line up', () => {
    const s = sub('u1', 5, 12);
    expect(subscriptionMatches(s, concert(1, 12, [5]), [5], follows())).toBe(true);
    expect(subscriptionMatches(s, concert(2, 99, [5]), [5], follows())).toBe(false);
    expect(subscriptionMatches(s, concert(3, 12, [6]), [6], follows())).toBe(false);
  });

  it('matches a band-only watch wherever that band plays', () => {
    const s = sub('u1', 5, null);
    expect(subscriptionMatches(s, concert(1, 12, [5]), [5], follows())).toBe(true);
    expect(subscriptionMatches(s, concert(2, 99, [5]), [5], follows())).toBe(true);
    expect(subscriptionMatches(s, concert(3, 12, [6]), [6], follows())).toBe(false);
  });

  it('matches a city-only watch for a band the user follows', () => {
    const s = sub('u1', null, 12);
    expect(subscriptionMatches(s, concert(1, 12, [5]), [5], follows(5))).toBe(true);
    expect(subscriptionMatches(s, concert(2, 99, [5]), [5], follows(5))).toBe(false);
  });

  it('ignores a city-only watch for a band only somebody else follows', () => {
    // The whole point of the change. Band rows are global and the scraper syncs
    // every one of them, so "any band in Stockholm" quietly became "every band
    // any account has ever added" the moment a second user signed up.
    const s = sub('u1', null, 12);
    expect(subscriptionMatches(s, concert(1, 12, [6]), [6], follows(5))).toBe(false);
  });

  it('matches a city-only watch when any one band on a shared bill is followed', () => {
    // Support slots and festivals put several bands on one concert row. One of
    // yours on the bill is reason enough to hear about the show.
    const s = sub('u1', null, 12);
    expect(subscriptionMatches(s, concert(1, 12, [6, 5, 7]), [6, 5, 7], follows(5))).toBe(true);
  });

  it('still matches a named band watch for a band that is not on the wishlist', () => {
    // Naming a band in the watch IS the request. Following it too is not
    // required, or every subscription would have to be mirrored on the wishlist.
    expect(subscriptionMatches(sub('u1', 5, null), concert(1, 12, [5]), [5], follows())).toBe(true);
    expect(subscriptionMatches(sub('u1', 5, 12), concert(2, 12, [5]), [5], follows())).toBe(true);
  });

  it('matches nothing for a city-only watch when the follow set is missing', () => {
    // Fails closed on purpose. A caller that forgets the argument gets silence,
    // not the old wildcard quietly forwarding everyone's bands again.
    expect(subscriptionMatches(sub('u1', null, 12), concert(1, 12, [5]), [5])).toBe(false);
    expect(subscriptionMatches(sub('u1', null, 12), concert(2, 12, [5]), [5], null)).toBe(false);
  });

  it('matches nothing for a watch with neither a band nor a city', () => {
    // The table allows both columns to be null. POST /notifications/subscriptions
    // rejects that, but a row written any other way must not become a wildcard
    // that forwards every concert in the system to whoever owns it.
    expect(subscriptionMatches(sub('u1', null, null), concert(1, 12, [5]), [5], follows(5))).toBe(false);
  });

  it('does not match a concert whose city was never resolved', () => {
    // city_id is null until /bulk upserts the City row. A city watch comparing
    // null to null would otherwise match every unresolved concert.
    expect(subscriptionMatches(sub('u1', null, null), concert(1, null, [5]), [5], follows(5))).toBe(false);
    expect(subscriptionMatches(sub('u1', 5, null), concert(2, null, [5]), [5], follows(5))).toBe(true);
  });
});

describe('matchesByUser', () => {
  it('gives each user the concerts their watches matched', () => {
    const concerts = [concert(1, 12, [5]), concert(2, 99, [6])];
    const subs = [sub('u1', 5, null), sub('u2', null, 99)];
    const followed = new Map([['u2', follows(6)]]);

    const byUser = matchesByUser(concerts, subs, followed);

    expect([...byUser.keys()].sort()).toEqual(['u1', 'u2']);
    expect(byUser.get('u1').concerts.map((c) => c.id)).toEqual([1]);
    expect(byUser.get('u2').concerts.map((c) => c.id)).toEqual([2]);
  });

  it('keeps one user’s city watch off another user’s bands', () => {
    // Two accounts, one shared band table: u1 watches Stockholm and follows
    // band 5, u2 has added band 6. u1 must not be told about band 6.
    const concerts = [concert(1, 12, [5]), concert(2, 12, [6])];
    const subs = [sub('u1', null, 12)];
    const followed = new Map([['u1', follows(5)]]);

    const byUser = matchesByUser(concerts, subs, followed);

    expect(byUser.get('u1').concerts.map((c) => c.id)).toEqual([1]);
  });

  it('leaves out a user with a city watch and an empty wishlist', () => {
    const byUser = matchesByUser([concert(1, 12, [5])], [sub('u1', null, 12)], new Map());
    expect(byUser.has('u1')).toBe(false);
  });

  it('lists a concert once for a user whose watches match it twice', () => {
    // Watching a band and watching the city it plays is the normal way to end
    // up here, and it must not double the entry in the message.
    const concerts = [concert(1, 12, [5])];
    const subs = [sub('u1', 5, null), sub('u1', null, 12)];
    const followed = new Map([['u1', follows(5)]]);

    const byUser = matchesByUser(concerts, subs, followed);

    expect(byUser.get('u1').concerts.map((c) => c.id)).toEqual([1]);
  });

  it('leaves out a user whose watches matched nothing', () => {
    const byUser = matchesByUser([concert(1, 12, [5])], [sub('u2', 7, null)], new Map());
    expect(byUser.has('u2')).toBe(false);
  });

  it('carries the email through, so the digest can send without re-reading the user', () => {
    const byUser = matchesByUser([concert(1, 12, [5])], [sub('u1', 5, null)], new Map());
    expect(byUser.get('u1').email).toBe('u1@example.com');
  });
});

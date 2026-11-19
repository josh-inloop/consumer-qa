import { test, expect } from '@playwright/test';
import { suppressBlockingModals } from '../helpers/suppressBlockingModals';

// TALOS-122682: NYC wine/spirits PDPs must attribute the sale to "Warehouse
// Wines & Spirits" (the state-licensed retailer for wine/spirits), not
// "Talos License LLC" (the beer/pantry merchant). Location 1546 (2680 Broadway,
// NY) has Warehouse Wines & Spirits correctly configured as its wine/spirits
// alcohol merchant, so a mismatch here points at the category-attribution
// logic itself rather than missing per-location config.
const BASE = new URL(process.env.BASE_URL ?? 'https://www.talos.app').origin;

const LOCATION_1546_COOKIE = {
  geocode_partial_match: false,
  geocode_results_count: 1,
  geocoder_postal_prefix_fallback: false,
  address: '2680 Broadway',
  city: 'New York',
  country: 'US',
  district: '',
  google_place_id: 'ChIJ5QqoyyX2wokRnxq5VuRV4aw',
  latitude: 40.798555,
  longitude: -73.968532,
  plus_code: '',
  route: 'Broadway',
  state: 'New York',
  street_number: '2680',
  zip: '10025',
  apt: '',
};

// Hennessy VS Cognac 50ml — confirmed in stock at location 1546.
const PDP_URL = `${BASE}/p/hennessy-vs-cognac-50ml-80-proof/p21904`;

test.describe('Alcohol merchant attribution @regression', () => {
  test('wine/spirits PDP at a confirmed-configured NY location shows Warehouse Wines & Spirits', async ({
    context,
    page,
  }) => {
    test.fail(
      true,
      'TALOS-122682: Wine/spirits PDPs show "Sold by Talos License LLC" instead of "Sold by Warehouse Wines & Spirits", fix pending'
    );

    const cookieDomain = `.${new URL(BASE).hostname.replace(/^www\./, '')}`;
    await context.addCookies([
      {
        name: 'talos_hp_address',
        value: encodeURIComponent(JSON.stringify(LOCATION_1546_COOKIE)),
        domain: cookieDomain,
        path: '/',
        secure: true,
        sameSite: 'Lax',
      },
    ]);

    await page.goto(PDP_URL, { waitUntil: 'domcontentloaded' });
    await suppressBlockingModals(page);

    await expect(page.getByText(/^Sold by/i)).toHaveText('Sold by Warehouse Wines & Spirits', {
      timeout: 20_000,
    });
  });
});

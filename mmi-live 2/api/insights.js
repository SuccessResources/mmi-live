// api/insights.js
// Vercel serverless function — fetches Meta Ads campaign insights by country
// Environment variables required:
//   META_ACCESS_TOKEN  — your long-lived Meta user access token
//   META_ACCOUNT_ID    — ad account ID, e.g. act_1382529368693354

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token     = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_ACCOUNT_ID;

  if (!token || !accountId) {
    return res.status(500).json({
      error: 'Missing env vars: META_ACCESS_TOKEN and META_ACCOUNT_ID must be set in Vercel'
    });
  }

  const preset = req.query.preset || 'last_30_days';
  const validPresets = ['last_7_days','last_14_days','last_30_days','last_90_days','this_month','last_month'];
  if (!validPresets.includes(preset)) {
    return res.status(400).json({ error: 'Invalid preset. Use: ' + validPresets.join(', ') });
  }

  try {
    // ── Fetch all pages from Meta Ads API
    let allRows = [];
    let nextUrl = `https://graph.facebook.com/v20.0/${accountId}/insights?` +
      new URLSearchParams({
        fields:      'campaign_name,campaign_id,spend,impressions,reach,cpm,frequency',
        breakdowns:  'country',
        date_preset: preset,
        level:       'campaign',
        limit:       '500',
        access_token: token
      });

    while (nextUrl) {
      const r    = await fetch(nextUrl);
      const json = await r.json();
      if (json.error) throw new Error(`Meta API error: ${json.error.message} (code ${json.error.code})`);
      allRows    = allRows.concat(json.data || []);
      nextUrl    = json.paging?.next || null;
    }

    // ── Group rows by country code
    const byCountry = {};

    for (const row of allRows) {
      const iso = row.country;
      if (!iso || iso === 'unknown') continue;

      if (!byCountry[iso]) {
        byCountry[iso] = {
          spend: 0, impressions: 0, reach: 0,
          freq_sum: 0, freq_count: 0,
          campaigns: {}
        };
      }

      const d = byCountry[iso];
      d.spend       += parseFloat(row.spend       || 0);
      d.impressions += parseInt(row.impressions   || 0);
      d.reach       += parseInt(row.reach         || 0);
      d.freq_sum    += parseFloat(row.frequency   || 0);
      d.freq_count  += 1;

      // Merge spend/impressions per campaign (same campaign can appear across multiple rows)
      const cid = row.campaign_id;
      if (!d.campaigns[cid]) {
        d.campaigns[cid] = {
          name:        row.campaign_name || 'Unknown Campaign',
          id:          cid,
          spend:       0,
          impressions: 0
        };
      }
      d.campaigns[cid].spend       += parseFloat(row.spend       || 0);
      d.campaigns[cid].impressions += parseInt(row.impressions   || 0);
    }

    // ── Compute derived metrics and finalise shape
    const result = {};

    for (const [iso, d] of Object.entries(byCountry)) {
      const campaigns = Object.values(d.campaigns)
        .map(c => ({
          ...c,
          spend:     Math.round(c.spend * 100) / 100,
          cpm:       c.impressions > 0 ? Math.round(c.spend / c.impressions * 1000 * 100) / 100 : 0,
          frequency: d.freq_count > 0  ? Math.round(d.freq_sum / d.freq_count * 100) / 100 : 0
        }))
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 20);

      result[iso] = {
        spend:          Math.round(d.spend * 100) / 100,
        impressions:    d.impressions,
        reach:          d.reach,
        cpm:            d.impressions > 0 ? Math.round(d.spend / d.impressions * 1000 * 100) / 100 : 0,
        frequency:      d.freq_count  > 0 ? Math.round(d.freq_sum / d.freq_count * 100) / 100 : 0,
        campaign_count: campaigns.length,
        campaigns
      };
    }

    return res.status(200).json({
      data:        result,
      preset,
      fetched_at:  new Date().toISOString(),
      total_rows:  allRows.length,
      markets:     Object.keys(result).length
    });

  } catch (err) {
    console.error('[insights] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

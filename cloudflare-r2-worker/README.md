# Observing Vault Worker

Cloudflare R2 + Workers backend for private FITS uploads and observing-planner data from `observing.html`.

## Free-tier shape

Cloudflare R2 includes a monthly free tier for standard storage, and Workers has a free request allowance. Keep FITS archives under the free storage limit or Cloudflare may require paid usage.

## Setup

1. Create a Cloudflare account.
2. Install Wrangler:

   ```bash
   npm install -g wrangler
   ```

3. Log in:

   ```bash
   wrangler login
   ```

4. Create the R2 bucket:

   ```bash
   wrangler r2 bucket create observing-vault
   ```

5. Set the private upload token:

   ```bash
   wrangler secret put UPLOAD_TOKEN
   ```

6. Deploy the Worker:

   ```bash
   wrangler deploy
   ```

7. Copy the deployed Worker URL into the Cloud Endpoint field on the NightVector page.

Do not commit the upload token. Enter it locally in the page when uploading.

The upload token protects R2 upload, list, and download requests. Target lookup, location lookup, and the Open-Meteo five-day forecast remain public so the planner works without exposing the vault secret.

Online target lookup resolves names through CDS Sesame and enriches the result through SIMBAD TAP. When available, NightVector automatically fills the custom-target magnitude, angular size in arcminutes, and planner object type before the target is added.

`exoplanets.html` is the NightVector transit workspace. Its public `/exoplanet-info` Worker route queries the NASA Exoplanet Archive `pscomppars` table for confirmed transiting planets and returns ephemerides, coordinates, transit geometry, host-star properties, and planet properties. The page calculates upcoming contact times, current transit phase, flux statistics, and a continuous-cadence APT starting plan.

## Upload performance

NightVector supports two upload routes:

- `Direct R2 / auto fallback`: recommended for large sessions. The Worker issues six-hour presigned URLs in batches of up to 100 objects, then the browser uploads each file directly to R2.
- `Worker proxy / compatibility`: the original route. The Worker streams each request body into R2 and requires no S3 credentials or bucket CORS rule.

Use `12 files` in parallel for a large session. Try `16` or `24` on a fast connection if the browser and network remain responsive. Reduce the setting if uploads become less stable. The live upload status reports the selected route and measured throughput in MB/s. Cloudflare Free accounts limit an individual Worker request body to 100 MB, so the direct R2 route is also the preferred route for individual files above that Worker request limit.

### Enable direct R2 uploads

1. Open **Storage & databases** > **R2 object storage**.
2. Select **Manage R2 API Tokens**.
3. Create an account API token with **Object Read & Write** access scoped to the `observing-vault` bucket.
4. Copy the **Access Key ID** and **Secret Access Key**. The secret is shown only once.
5. Open **Compute** > **Workers & Pages** > **observing-vault** > **Settings**.
6. Add these Worker variables and secrets:

   | Variable | Type | Value |
   | --- | --- | --- |
   | `R2_ACCOUNT_ID` | Text | Cloudflare account ID |
   | `R2_BUCKET_NAME` | Text | `observing-vault` |
   | `R2_ACCESS_KEY_ID` | Secret | R2 token Access Key ID |
   | `R2_SECRET_ACCESS_KEY` | Secret | R2 token Secret Access Key |

7. Redeploy the Worker code.
8. Open **Storage & databases** > **R2 object storage** > **observing-vault** > **Settings** > **CORS Policy** and add:

   ```json
   [
     {
       "AllowedOrigins": [
         "https://nic5153.github.io",
         "http://localhost:8020",
         "http://127.0.0.1:8020"
       ],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

Use the GitHub Pages origin for the permanent site. Add a different local-server origin only when its port changes. Keep the R2 API credentials in Worker secrets; do not enter them in `observing.html`.

Cloud Inventory follows R2 continuation cursors until every matching object has been listed. R2 may return fewer than 1,000 objects on a page even when additional objects exist.

## Calibration library

Select `Calibration library / FITS auto-detect` in Session Vault before staging calibration frames. NightVector reads FITS headers locally in the browser and extracts available values for:

- Capture date
- Frame type and filter
- Camera temperature
- Gain and offset
- Exposure time
- Binning
- Camera and telescope

Calibration uploads use separate R2 paths such as:

```text
calibration/Flats L/2026-05-31/C8_ATR585M/gain-252_offset-20_temp--10C_exp-2s_bin-1x1_filter-L/
```

Multiple flat sessions remain distinct by capture date and settings. Missing FITS values are stored as `unknown` instead of blocking upload.

## Planner profiles

`observing.html` saves planner profiles locally in the browser and can sync the complete planner bundle to D1 for use across devices. Each profile can contain:

- Rig, site, observing mode, date range, altitude, filter, duration, and dithering preferences.
- Multiple named observing programs.
- Saved exposure-plan snapshots with target metadata, APT exports, integration goals, and captured-hours progress.
- JSON export and import for backups or sharing.

Use **Sync Cloud** on the device with the current planner data. On another device, enter the same Worker endpoint and upload token in **Session Vault**, then use **Load Cloud**. Loading from D1 preserves the previous local state in browser storage before replacing it.

## Enable D1 cloud profile sync

Local planner profiles work without D1. Binding D1 enables authenticated cross-device cloud backup and restore. FITS uploads remain in R2.

### Dashboard setup

1. Open the Cloudflare dashboard.
2. Go to **Storage & databases** > **D1 SQL database**.
3. Select **Create Database**.
4. Name it `nightvector-planner`, then select **Create**.
5. Open the new database and select **Console**.
6. Copy the contents of `planner-schema.sql`, paste them into the D1 console, and run the SQL.
7. Go to **Compute** > **Workers & Pages** > **observing-vault**.
8. Open **Bindings** and select **Add binding**.
9. Choose **D1 database**.
10. Set the variable name to `PLANNER_DB`.
11. Select the `nightvector-planner` database and save the binding.
12. Redeploy the Worker if Cloudflare prompts you to deploy the updated configuration.

### Wrangler equivalent

```bash
npx wrangler@latest d1 create nightvector-planner
npx wrangler@latest d1 execute nightvector-planner --remote --file=./planner-schema.sql
```

Then add the generated D1 configuration block to `wrangler.toml` using `PLANNER_DB` as the binding name.

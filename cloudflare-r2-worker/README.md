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

## Planner profiles

`observing.html` saves planner profiles locally in the browser. Each profile can contain:

- Rig, site, observing mode, date range, altitude, filter, duration, and dithering preferences.
- Multiple named observing programs.
- Saved exposure-plan snapshots with target metadata, APT exports, integration goals, and captured-hours progress.
- JSON export and import for backups or sharing.

## Prepare D1 for cloud profile sync

Local planner profiles work without D1. D1 prepares the structured cloud database for a later authenticated multi-user sync layer. FITS uploads remain in R2.

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

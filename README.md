# Form-Markexhaust

A party and product order form with an admin-only Excel export.

## Run locally with Node.js

Install Node.js 18 or newer, then open PowerShell in this folder.

1. Put the private `parties.json` and `products.json` master-data files in this folder.
2. Start the Node.js server:

   ```powershell
   npm.cmd start
   ```

3. Enter an admin password with at least 12 characters when prompted. The password is masked while typing.
4. Open the party form at `http://127.0.0.1:8787/` or the admin panel at `http://127.0.0.1:8787/admin`.

The party JSON must contain `party code`, `party name`, `party add1`, `party add 2`, `city`, `state`, `pin`, `state 1`, `status`, and `md/td` fields. The product JSON must contain `part number`, `product code`, `product name`, `mrp`, `md price`, and `td price` fields.

Submissions are saved locally to `submissions.json`. These data files and Excel workbooks are excluded from Git by `.gitignore`; keep private business data in approved private storage. The admin Excel download uses a browser-hosted XLSX library and requires an internet connection.

`PARTY_ADMIN_PASSWORD` can be set in the process environment instead of entering it at startup. The Node server listens on `127.0.0.1` by default; `HOST` and `PORT` can override the address.

Run the backend tests with `npm.cmd test`.

This project now uses the Node.js backend; the former PowerShell server has been removed. Vercel can run Node.js functions, but this local server writes submissions to the machine's JSON file. A Vercel deployment still needs serverless API routes and approved persistent storage for private master data and submissions; local file writes are not durable there.

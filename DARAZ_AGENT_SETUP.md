# PriceNova Daraz Agent — Faable setup

## Runtime and deployment

- Node.js: 24.x
- Install command: `npm install` (configured in `faable.json`)
- Build command: `npm run build`
- Start command: `npm start`

Faable reads the dependencies from the root `package.json` during deployment.

## Required Faable environment variables

Existing variables:
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `ADMIN_PASSWORD`
- `GEMINI_API_KEY` (recommended primary model)
- `GROQ_API_KEY` (fallback model)

Agent configuration:
- `GEMINI_MODEL` (optional; default: `gemini-2.5-flash`)
- `GROQ_MODEL` (optional; default: `llama-3.3-70b-versatile`)
- `DARAZ_PRODUCT_FEED_URL` (required; HTTPS URL for a Daraz-approved or affiliate-network product API/feed)
- `DARAZ_PRODUCT_FEED_TOKEN` (optional; sent as a Bearer token)

Do not put API keys in GitHub files. Add them only in Faable's environment/secrets settings.

## Product feed contract

The configured feed endpoint must accept:
- `q`: search keyword
- `limit`: requested result limit

It must return JSON as either an array of product records or an object containing a `products`, `items`, or `data.products` array.

Each product should provide:
- `id` or `productId`
- `url`: canonical HTTPS Daraz product URL
- `title` or `name`
- `price` or `currentPrice`
- Optional: `currency`, `originalPrice`, `brand`, `sellerName`, `rating`, `reviewCount`, `soldCount`, `imageUrl`

The application validates product URLs and required fields before saving. The Agent does not scrape Daraz pages directly or bypass access controls. A real product hunt remains unavailable until an approved data feed and AI provider key are configured.

## Existing data

The current Turso `products`, `price_history`, and `price_alerts` tables are retained. The hunting module keeps the existing product and hunt-history data model and adds missing product metadata columns when needed.

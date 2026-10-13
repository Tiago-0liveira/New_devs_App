# Final Report

Trigger: Client A said *"The revenue numbers on your dashboard don't match our internal records."*

| # | Issue | File | Impact |
|---|---|---|---|
| 1 | Cache key had no tenant | `services/cache.py` | Tenant sees another tenant's revenue |
| 2 | DB pool failed to start, mock data served | `core/database_pool.py`, `requirements.txt` | Dashboard numbers never came from the DB |
| 3 | Property list hardcoded in the UI | `Dashboard.tsx` | Every tenant saw prop-001..005 |
| 4 | Monthly revenue ignored property timezone (and was a stub) | `services/reservations.py` | Sunset's March total for prop-001 off by 1250.00 |
| 5 | Sub-cent amounts + float rounding | `services/reservations.py`, `dashboard.py`, `RevenueSummary.tsx` | Totals off by a cent vs. invoices |

## 1. Cache leaks across tenants

- **Problem:** key was `revenue:{property_id}`. `prop-001` exists for both tenants, so the first to load filled the cache for the other (5 min TTL).
- **Fix:** key is now `revenue:{tenant_id}:{property_id}`.
- **How found:** `redis-cli keys '*'` showed `revenue:prop-001` with no tenant, while the DB has `prop-001` under both `tenant-a` and `tenant-b`.

## 2. DB connection failure hidden by mock data

- **Problem:** the pool crashed on init (`'Settings' object has no attribute 'supabase_db_user'`, missing `greenlet`, `async with` on a coroutine). `calculate_total_revenue` then silently returned hardcoded mock totals, so the UI never read Postgres.
- **Fix:** pool URL built from `settings.database_url`; removed the invalid `poolclass=QueuePool`; `get_session()` made sync; added `sqlalchemy[asyncio]`. Mock fallback left in place.
- **How found:** compared the dashboard with manual SQL on the DB (port 5433), then `docker-compose logs backend` showed `Database error ... Database pool not available`.

## 3. Hardcoded property list

- **Problem:** Sunset saw 5 properties; the DB gives it only 3 (Ocean has the other 3 incl. its own `prop-001`).
- **Fix:** new `GET /api/v1/dashboard/properties` returns the caller's tenant properties; the dropdown loads from it.
- **How found:** compared the properties on the website against the `properties` table, which is where the first mismatch appeared.

## 4. March totals split at the wrong month boundary

- **Trigger:** Client A: *"We're showing different totals for March."* Only one month was named, so the bug had to be in how reservations get bucketed into months, not in the totals themselves.
- **Suspicion:** properties are in different timezones (Paris, New York) but `check_in_date` is stored in UTC. A booking near midnight on the 1st can fall in a different month depending on which clock decides.
- **How found:**
  - `calculate_monthly_revenue` was never called and always returned `Decimal('0')`. Its boundaries were naive `datetime(year, month, 1)`, i.e. UTC.
  - Ran March per property in SQL with UTC boundaries vs. `check_in_date AT TIME ZONE p.timezone`. Only Sunset `prop-001` differs: **1000.00 (UTC) vs 2250.00 (local)**.
  - Cause is `res-tz-1`: check-in `2024-02-29 23:30 UTC` = `2024-03-01 00:30` Paris. Client counts it in March, UTC puts it in February. 1000.00 is also the old mock value the dashboard showed for prop-001.
- **Fix:** `calculate_monthly_revenue(property_id, tenant_id, month, year)` now queries Postgres, joins `properties` for the timezone, and filters on `check_in_date AT TIME ZONE p.timezone` within `[1st of month, 1st of next month)`. Tenant-scoped; December rolls into next year.
- **Verified:** March 2024 → Sunset prop-001 2250.000 (2249.99 after fix 5), prop-002 4975.500, prop-003 6100.500; Ocean prop-001 0, prop-004 1776.500, prop-005 3256.000. February and December are 0 for all.

## 5. Totals "slightly off by a few cents"

- **Trigger:** finance team: totals *"slightly off by a few cents here and there"*, couldn't say when or why.
- **Suspicion:** money handled outside exact decimals somewhere between DB and screen, or a rounding-order mismatch with how finance totals bookings.
- **How found:** traced the value DB → API → UI:
  - `total_amount` is `NUMERIC(10,3)`. Only Sunset `prop-001` has sub-cent bookings (`res-dec-1/2/3` = 333.333 + 333.333 + 333.334). Sum-then-round = **2250.00**; round-each-booking-then-sum (what invoices add up to) = **2249.99**. That's the "here and there": only properties with sub-cent bookings drift.
  - `dashboard.py` did `float(total)`; Python `round()` on that float gives `1.005 → 1.0`, `2.675 → 2.67`.
  - `RevenueSummary.tsx` did `Math.round(x * 100) / 100`, inconsistent on half-cents (`1.005 → 1.00`, `1000.005 → 1000.01`), then `toLocaleString` rounded again. The component already had a "Precision Mismatch Detected" warning for this.
- **Fix:**
  - Both revenue queries use `SUM(ROUND(total_amount, 2))`: each booking rounded to cents (half-up) before summing, matching invoiced amounts.
  - API keeps `Decimal`, quantizes to 0.01 `ROUND_HALF_UP` and returns `total_revenue` as a string (`"2249.99"`), no float.
  - Frontend shows the API value as-is: no `Math.round`; removed the obsolete precision warning.
- **Verified:** Sunset prop-001 now 2249.99 (total and March); all other properties unchanged. Revenue cache keys flushed so old values aren't served.

## Verified

| Tenant | Property | Revenue |
|---|---|---|
| Sunset | prop-001 | 2249.99 |
| Sunset | prop-002 | 4975.50 |
| Sunset | prop-003 | 6100.50 |
| Ocean | prop-001 | 0.00 |
| Ocean | prop-004 | 1776.50 |
| Ocean | prop-005 | 3256.00 |

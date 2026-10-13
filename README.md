# Revenue Dashboard: Bug Report

## What was reported

| Who | Complaint |
|---|---|
| Client A (Sunset Properties) | Dashboard revenue doesn't match their records, specifically for **March**. |
| Client B (Ocean Rentals) | On refresh, they **sometimes** see revenue that looks like another company's. |
| Finance | Some totals are **off by a few cents**, "here and there". |

## Approach

1. **The database is the source of truth.** Before reading any code, I computed the expected revenue for every property straight from Postgres (`SUM(total_amount)` grouped by tenant and property).
2. **Follow each number through the stack.** For each property I compared the database, then Redis, then the API (`curl` as each client), then the UI. The first layer where the value changes is where the bug is.
3. **Use the wording of each complaint as a clue.** "Sometimes, on refresh" suggests a cache. "March" suggests month boundaries. "A few cents here and there" suggests rounding that only affects some rows.

The work found five bugs. Each one has its own commit.

## 1. Cache leaks revenue across tenants (Ocean's privacy issue)

- **How I found it:** "Sometimes when we refresh" pointed at the Redis cache (5 min TTL). I flushed Redis, loaded `prop-001` as Sunset, and ran `redis-cli keys '*'`. The key was `revenue:prop-001`, with no tenant in it, and the value inside said `tenant-a`. Next I requested `prop-001` as Ocean and got that same Sunset object back. The `properties` table showed why: `prop-001` exists under **both** `tenant-a` and `tenant-b` as two different properties.
- **Root cause:** `backend/app/services/cache.py` built the key from `property_id` only. Whichever tenant loaded a shared ID first filled the cache, and the other tenant was served that entry until it expired.
- **Fix:** the key is now `revenue:{tenant_id}:{property_id}`. Commit `cf78afe59`.

## 2. Database never used, mock numbers served

- **How I found it:** after the cache fix, Sunset `prop-001` still showed **1000.00** while SQL gave **2250.00**. `docker-compose logs backend` showed that the connection pool crashed at startup with `'Settings' object has no attribute 'supabase_db_user'`, then complained about the missing `greenlet` library, and then logged `Database pool not available` on every request. `calculate_total_revenue` catches that error and returns a hardcoded mock dictionary, and 1000.00 is one of the values in it.
- **Root cause:** `backend/app/core/database_pool.py` read settings fields that don't exist. It also passed `QueuePool` to an async engine, which isn't allowed, and used `async with` on a coroutine. `greenlet` wasn't installed either. Because the mock fallback hid the failure, every number on the dashboard was fake.
- **Fix:** the pool is now built from `settings.database_url`. I removed `poolclass=QueuePool`, fixed the `get_session()` context manager, and added `sqlalchemy[asyncio]` to `requirements.txt`. Commit `31e42ae42`.

## 3. Hardcoded property list

- **How I found it:** I logged in as each client in a separate browser. Both saw the same five properties (`prop-001`…`prop-005`). The `properties` table gives each tenant only three, and Ocean's three include its own `prop-001`. I grepped `Dashboard.tsx` for `prop-00` and found the list was a literal array.
- **Root cause:** the frontend never asked the backend which properties belong to the logged-in tenant.
- **Fix:** I added a new `GET /api/v1/dashboard/properties` endpoint, scoped to the caller's tenant. The dropdown loads from it through a new `useDashboardProperties` hook. Commits `ec427e33c` and `a99ec1e71`.

## 4. March total wrong: months split in UTC, not property time (Sunset's issue)

- **How I found it:** Sunset complained about one specific month, not about every total. That pointed to how bookings are assigned to months. Properties are in Paris and New York, but `check_in_date` is stored in UTC. I ran March per property twice: once with UTC boundaries and once with `check_in_date AT TIME ZONE p.timezone`. Only Sunset `prop-001` differed: **1000.00 (UTC) vs 2250.00 (local)**. The difference is a single booking, `res-tz-1`. It checks in at `2024-02-29 23:30 UTC`, which is `2024-03-01 00:30` in Paris. Sunset counts it in March, while UTC puts it in February.
- **Root cause:** `calculate_monthly_revenue` in `backend/app/services/reservations.py` used naive `datetime(year, month, 1)` boundaries, which are effectively UTC. It was also a stub that always returned `0`.
- **Fix:** I implemented it against Postgres. It joins `properties` to get the timezone, filters `check_in_date AT TIME ZONE p.timezone` to `[1st of month, 1st of next month)`, is scoped by tenant, and rolls December over into January. Commit `9a62f7951`.

## 5. Totals off by a few cents (finance)

- **How I found it:** "Here and there" suggested that only some rows were affected. `total_amount` is `NUMERIC(10,3)`, so I looked for amounts with a third decimal. Only Sunset `prop-001` has any: `res-dec-1/2/3` = 333.333 + 333.333 + 333.334. Summing first and rounding at the end gives **2250.00**. Rounding each booking to cents first, which is how invoices add up, gives **2249.99**. Following the value onward, `dashboard.py` converted it with `float(total)`, and `RevenueSummary.tsx` rounded it again with `Math.round(x * 100) / 100`. Both handle half-cents inconsistently: Python's `round(1.005, 2)` returns `1.0`, and JS `Math.round(1.005*100)/100` returns `1` but `Math.round(1000.005*100)/100` returns `1000.01`.
- **Root cause:** sub-cent amounts were rounded only once, after summing, and money passed through floats and was rounded twice.
- **Fix:** both revenue queries now use `SUM(ROUND(total_amount, 2))`. The API keeps a `Decimal`, quantizes it with `ROUND_HALF_UP`, and returns `total_revenue` as a string (`"2249.99"`). The frontend displays that value without rounding it again. Commit `920b86d76`.

## Result

| Tenant | Property | Before | After |
|---|---|---|---|
| Sunset | prop-001 | 1000.00 (mock) | 2249.99 |
| Sunset | prop-002 | 4975.50 | 4975.50 |
| Sunset | prop-003 | 6100.50 | 6100.50 |
| Ocean | prop-001 | 1000.00 (Sunset's cached data) | 0.00 |
| Ocean | prop-004 | 1776.50 | 1776.50 |
| Ocean | prop-005 | 3256.00 | 3256.00 |

Redis keys now include the tenant (`revenue:tenant-a:prop-001`). Each client sees only its own three properties, and March for Sunset `prop-001` includes the Feb 29 / Mar 1 booking.

## Known, left out of scope

- The dashboard shows all-time totals, not a selected month. That matches March today only because all the seed data falls in March.
- If the database goes down, the mock fallback still returns data that isn't tenant-specific. It should fail loudly instead.
- The API has a `default_tenant` fallback when the token has no tenant.
- A new database pool is created on every request.
- The "↑12%" growth badge is a hardcoded placeholder.

## Verify

```bash
docker-compose up --build -d && docker-compose exec redis redis-cli flushall
# log in at http://localhost:3000 as sunset@propertyflow.com / client_a_2024
# and (incognito) ocean@propertyflow.com / client_b_2024, then compare with the table above
```

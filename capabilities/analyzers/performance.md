# Performance review

**Question:** What in this code gets slower or more expensive as data, users or time grow — and what
is already slow at today's size?

Estimate with the real sizes when you can find them (row counts, typical list lengths, request rate,
payload size). A quadratic loop over ten items is a note; over ten thousand it is critical.

**Do the arithmetic before you judge.** For every query, loop or fan-out in scope, write down the
work it does with the given sizes — rows touched, combinations, calls — as a number. "Fast today"
without that number is not a conclusion. If you cannot measure, reason from the shape: the same
table joined *k* times on one key with *r* rows per key means up to *r*^*k* combinations per item
(9 rows and 6 joins ≈ 530 000). Anything on a per-request path that reaches the hundred-thousands
per item, or runs more than once per request, is **critical**, even when the data set looks small.

## Checks

1. **Queries.** N+1 (a query per item in a loop); joins that multiply rows (several joins on the same
   key-value/meta table, one per condition, grow as rows-per-item to the power of joins); `OR`
   across different joined columns that defeats indexes; `SELECT *` into memory; missing index for a
   new `WHERE`/`ORDER BY`/join column; `LIKE '%…'`; functions on indexed columns; unbounded result
   sets without `LIMIT`. Look at what an ORM or query builder **generates**, not only at the call.
2. **Repeated work.** The same expensive call made twice per request (e.g. by two components on one
   page); recomputation inside a loop of something loop-invariant; cache keys that never hit.
3. **Algorithmic complexity.** Nested loops over collections that grow; `includes`/`indexOf`/`in`
   on lists inside loops (use a set or map); sorting inside a loop; string building by repeated
   concatenation in hot paths.
4. **I/O on the hot path.** Synchronous file, network or subprocess calls per request; missing
   timeouts on outbound calls (one slow dependency stalls every worker); sequential awaits that
   could run in parallel.
5. **Memory and resources.** Loading whole files or tables to use a part; listeners, timers,
   subscriptions, connections or file handles not released; caches without a bound; per-process
   memory multiplied by the worker count against the container limit.
6. **Front end.** Re-renders from unstable props or context; large lists without virtualisation;
   blocking scripts; unoptimised images; bundle growth from a heavy import for a small use.
7. **Concurrency limits.** Pools, worker counts and connection limits that do not match each other
   (e.g. a proxy keeping more idle keep-alive connections than the backend has workers).

## Sweep

Probe for these and judge every hit:

- **Query builders and ORMs:** `meta_query`, `tax_query`, `WP_Query`/`get_posts`, `include:`/
  `joins(`/`.populate(`, raw SQL with `JOIN` — for each, write down the SQL it generates and count
  joins on the same table.
- **Queries or remote calls inside loops:** a query, HTTP call, file read or subprocess inside `for`/
  `foreach`/`map`/`while`.
- **Unbounded reads:** `posts_per_page => -1`, `SELECT` without `LIMIT`, `readFile`/`file_get_contents`
  on growing files, `findAll`.
- **Same expensive call from several places** on one request (search the function name).

## Language notes

- **WordPress:** `meta_query` builds one join per clause on `postmeta`, and for ordinary clauses the
  `meta_key` condition sits in `WHERE`, not in the join's `ON` — so each join first matches **all**
  meta rows of the post and the joins multiply (rows-per-post ^ joins), they do not add up. Several
  clauses in `OR` can explode — check the generated SQL (`$query->request`) and consider one query with
  `COALESCE`/`CASE` over two joins; `get_posts` inside template loops; autoloaded options size.
- **React / Next.js:** server components fetching the same data twice; missing `key`; effects that
  refetch on every render; client components importing server-only libraries.
- **Swift:** work on the main actor; `body` doing computation; images decoded at full size.
- **Rust:** clones in hot loops; `collect` to discard; blocking in async executors.
- **SQL in general:** check `EXPLAIN` when the database is reachable read-only.

## Critical when

It is slow or failing at current data sizes, or grows super-linearly with something that grows in
normal use (content, users, history). Micro-optimisations are notes.

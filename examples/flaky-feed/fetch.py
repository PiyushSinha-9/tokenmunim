"""A feed that answers "busy, retry" for one item forever.

It looks transient, so an agent told to retry will retry. It never clears,
because the item it asks for was never published. That is the shape most
agent loops take, and what TokenMunim's loop circuit is for.
"""

import sys

ITEMS = ['2024-01-04', '2024-01-11', '2024-01-18', '2024-01-25', '2024-02-01']
NEVER_PUBLISHED = '2024-01-25'

fetched = 0
for item in ITEMS:
    if item == NEVER_PUBLISHED:
        print(f'fetched {fetched} of {len(ITEMS)}')
        print(f'error: 503 Service Unavailable (transient): {item} is not ready yet. Retry in a few seconds.', file=sys.stderr)
        sys.exit(1)
    fetched += 1
print(f'fetched {fetched} of {len(ITEMS)}')

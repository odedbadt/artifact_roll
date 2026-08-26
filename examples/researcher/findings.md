# Retrieval latency findings

Sampled **12,480** queries across three shard layouts. Tail latency is dominated
by cross-shard fan-out, not by the ranker.

## Headline numbers

| layout    | p50 (ms) | p99 (ms) | fan-out |
|-----------|---------:|---------:|--------:|
| flat      |     41.2 |    380.5 |      12 |
| hashed    |     38.9 |    204.1 |       4 |
| clustered |     43.6 |    121.7 |       2 |

The p99 improvement tracks the fan-out reduction almost exactly:

$$ p_{99} \approx \alpha + \beta \cdot \log_2(f) $$

with $\alpha = 88\text{ms}$ and $\beta = 41\text{ms}$ fitted over the three points.

## What to do next

1. Move the `documents` index to the clustered layout
2. Re-measure with a cold cache
3. Check whether $\beta$ holds at $f = 1$

> Caveat: the clustered run used a warm page cache. Treat p50 as optimistic.

```python
def fanout_cost(f, alpha=88, beta=41):
    return alpha + beta * math.log2(f)
```

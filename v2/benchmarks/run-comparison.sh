#!/usr/bin/env bash
#
# Run runtime comparison benchmarks: Bun vs Node.js
#
# Measures:
# - Cold start time (startup latency)
# - Memory footprint
# - JSON parsing speed
# - Subprocess execution speed
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCHMARK_SCRIPT="$SCRIPT_DIR/runtime-comparison.ts"

echo "=== Runtime Comparison Benchmark ==="
echo ""

# Check if Bun is installed
if ! command -v bun &> /dev/null; then
    echo "WARNING: Bun not found. Install with: curl -fsSL https://bun.sh/install | bash"
    echo "Skipping Bun benchmarks..."
    BUN_AVAILABLE=false
else
    BUN_AVAILABLE=true
    echo "Bun version: $(bun --version)"
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found"
    exit 1
fi

echo "Node.js version: $(node --version)"
echo ""

# Benchmark 1: Node.js
echo "--- Benchmarking Node.js ---"
START_NODE=$(date +%s%N)
node "$BENCHMARK_SCRIPT" > /tmp/benchmark-nodejs.log 2>&1
END_NODE=$(date +%s%N)
COLD_START_NODE=$(( (END_NODE - START_NODE) / 1000000 )) # Convert to milliseconds
echo "Cold start time: ${COLD_START_NODE} ms"
cat /tmp/benchmark-nodejs.log
echo ""

# Benchmark 2: Bun (if available)
if [ "$BUN_AVAILABLE" = true ]; then
    echo "--- Benchmarking Bun ---"
    START_BUN=$(date +%s%N)
    bun "$BENCHMARK_SCRIPT" > /tmp/benchmark-bun.log 2>&1
    END_BUN=$(date +%s%N)
    COLD_START_BUN=$(( (END_BUN - START_BUN) / 1000000 ))
    echo "Cold start time: ${COLD_START_BUN} ms"
    cat /tmp/benchmark-bun.log
    echo ""
fi

# Compare results
echo "=== Comparison Summary ==="
echo ""

if [ "$BUN_AVAILABLE" = true ]; then
    if [ -f "$SCRIPT_DIR/results-nodejs.json" ] && [ -f "$SCRIPT_DIR/results-bun.json" ]; then
        echo "Node.js Results:"
        cat "$SCRIPT_DIR/results-nodejs.json" | grep -E "(memory|jsonParse|subprocess)" || true
        echo ""

        echo "Bun Results:"
        cat "$SCRIPT_DIR/results-bun.json" | grep -E "(memory|jsonParse|subprocess)" || true
        echo ""

        # Cold start comparison
        echo "Cold Start Comparison:"
        echo "  Node.js: ${COLD_START_NODE} ms"
        echo "  Bun:     ${COLD_START_BUN} ms"

        if [ "$COLD_START_BUN" -lt "$COLD_START_NODE" ]; then
            IMPROVEMENT=$(( (COLD_START_NODE - COLD_START_BUN) * 100 / COLD_START_NODE ))
            echo "  Winner: Bun (${IMPROVEMENT}% faster)"
        else
            echo "  Winner: Node.js"
        fi
    fi
else
    echo "Bun not available for comparison"
    echo "Node.js Results:"
    cat "$SCRIPT_DIR/results-nodejs.json" | grep -E "(memory|jsonParse|subprocess)" || true
fi

echo ""
echo "=== Recommendation ==="
echo ""

if [ "$BUN_AVAILABLE" = true ] && [ "$COLD_START_BUN" -lt 50 ]; then
    echo "✅ Bun meets target (<50ms cold start)"
    echo "Recommendation: Use Bun for v2 (performance wins)"
elif [ "$COLD_START_NODE" -lt 100 ]; then
    echo "⚠️  Bun not available or doesn't meet target"
    echo "Recommendation: Use Node.js (stable, mature)"
else
    echo "❌ Both runtimes exceed target"
    echo "Recommendation: Optimize cold start path"
fi

echo ""
echo "Detailed results saved to:"
echo "  - $SCRIPT_DIR/results-nodejs.json"
if [ "$BUN_AVAILABLE" = true ]; then
    echo "  - $SCRIPT_DIR/results-bun.json"
fi

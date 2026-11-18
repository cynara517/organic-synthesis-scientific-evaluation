"""Harbor custom-agent wrapper for the scientific-trace plugin.

Usage:
    PYTHONPATH=/path/to/scitrace_harbor harbor run -p <task> \
        -a scitrace_harbor.agent:ScientificTraceAgent -m <model> ...
"""

from scitrace_harbor.agent import ScientificTraceAgent

__all__ = ["ScientificTraceAgent"]

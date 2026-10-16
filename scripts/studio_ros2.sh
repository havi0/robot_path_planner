#!/bin/bash
# Run NEXUS inside WSL2 with ROS 2 Jazzy sourced (see docs/HARDWARE.md §0).
#   bash scripts/studio_ros2.sh                 -> Studio on port 8000
#   bash scripts/studio_ros2.sh pytest tests/   -> any other command in the same environment
set -e
source /opt/ros/jazzy/setup.bash
source "$HOME/nexus-venv/bin/activate"
cd "$(dirname "$0")/.."
if [ $# -eq 0 ]; then
    exec python -W ignore main.py studio --port "${PORT:-8000}"
elif [ "$1" = "pytest" ]; then
    shift; exec python -m pytest -p no:cacheprovider "$@"
else
    exec "$@"
fi

"""Turning raw sensor data into the fixed beam layout the policy expects."""
import numpy as np


def wrap_angle(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


def resample_scan(ranges, angle_min, angle_increment, target_angles, max_range,
                  min_valid_range=0.0, angle_offset=0.0):
    """Resample a real LiDAR scan (e.g. ROS LaserScan, 360+ beams) to the
    training beam layout by taking the MINIMUM valid range inside each target
    beam's angular sector (conservative: never hides an obstacle).

    Returns an array with np.nan where a sector has no valid return.
    """
    ranges = np.asarray(ranges, dtype=np.float64)
    src_angles = wrap_angle(angle_min + angle_offset + angle_increment * np.arange(len(ranges)))
    valid = np.isfinite(ranges) & (ranges > min_valid_range)
    no_return = np.isposinf(ranges)  # ROS convention: +inf = nothing within range
    clipped = np.minimum(ranges, max_range)

    n = len(target_angles)
    half_width = np.pi / n if n > 1 else np.pi
    out = np.full(n, np.nan)
    for i, ta in enumerate(target_angles):
        in_sector = np.abs(wrap_angle(src_angles - ta)) <= half_width
        if (in_sector & valid).any():
            out[i] = clipped[in_sector & valid].min()
        elif (in_sector & no_return).any():
            out[i] = max_range
    return out


def fill_invalid(ranges, max_range):
    """For the POLICY input only: treat missing returns as free space (max range).
    The safety layer works on raw readings and treats missing data as a fault."""
    return np.where(np.isfinite(ranges), np.clip(ranges, 0.0, max_range), max_range)

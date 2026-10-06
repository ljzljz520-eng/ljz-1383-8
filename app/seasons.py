"""Season engine: seasons are defined by the site owner per region.

Rules are stored as day-of-year boundaries in a leap-year (year 2000) calendar,
so Feb 29 dates work uniformly. Seasons never derive from a hard-coded month
table: the active rule set for the *declared region* decides everything.
"""
from datetime import date

LEAP_YEAR = 2000
SEASONS = ("spring", "summer", "autumn", "winter")
SEASON_CN = {"spring": "春", "summer": "夏", "autumn": "秋", "winter": "冬"}


def doy(d):
    """Day of year computed on a leap-year calendar (year-independent mapping)."""
    return date(LEAP_YEAR, d.month, d.day).timetuple().tm_yday


def parse_date(s):
    return date.fromisoformat(s[:10])


def validate_boundaries(b):
    """Four distinct starts; they must partition the year into 4 non-empty arcs."""
    vals = [b["spring_doy"], b["summer_doy"], b["autumn_doy"], b["winter_doy"]]
    if sorted(set(vals)) != sorted(vals):
        raise ValueError("四季起始日必须互不相同")
    for v in vals:
        if not 1 <= v <= 366:
            raise ValueError("起始日超出 1..366")
    # cyclic ordering: spring -> summer -> autumn -> winter -> wrap
    order = [b["spring_doy"], b["summer_doy"], b["autumn_doy"], b["winter_doy"]]
    # Every season arc must be non-empty when walking forward cyclically.
    for i in range(4):
        start = order[i]
        nxt = order[(i + 1) % 4]
        length = (nxt - start) % 366
        if length == 0:
            raise ValueError("季节区间不能为空")


def season_for_doy(doy_value, b):
    """Walk the cyclic boundary list; a day belongs to the season whose start
    it has most recently passed (inclusive)."""
    order = [
        ("spring", b["spring_doy"]),
        ("summer", b["summer_doy"]),
        ("autumn", b["autumn_doy"]),
        ("winter", b["winter_doy"]),
    ]
    best = None
    for name, start in order:
        # forward cyclic distance from boundary start to the day
        delta = (doy_value - start) % 366
        if best is None or delta < best[1]:
            best = (name, delta)
    return best[0]


def season_for_date(d, boundaries):
    return season_for_doy(doy(d), boundaries)


def rule_boundaries(rule_row):
    return {
        "spring_doy": rule_row["spring_doy"],
        "summer_doy": rule_row["summer_doy"],
        "autumn_doy": rule_row["autumn_doy"],
        "winter_doy": rule_row["winter_doy"],
    }


def active_rule(conn, region_id=None):
    if region_id is None:
        region_id = __import__("app.db", fromlist=["get_config"]).get_config(
            conn, "active_region_id", "1"
        )
    row = conn.execute(
        "SELECT * FROM season_rules WHERE region_id=? AND is_active=1", (region_id,)
    ).fetchone()
    if row is None:
        raise ValueError("该地区没有启用的分季规则")
    return row

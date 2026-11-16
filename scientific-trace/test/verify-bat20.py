"""Independent numeric checks against the BAT20 task specification.

Reads the supplied CSV inputs and newly generated artifacts, never old answers.
"""
from pathlib import Path
import json
import math
import sys
import numpy as np
import pandas as pd
from scipy.optimize import curve_fit

task = Path(sys.argv[1])
result = task / "results"
pv = pd.read_csv(task / "data/nrel_champion_efficiency.csv")
sq = pd.read_csv(task / "data/sq_limit_data.csv")
fits = json.loads((result / "learning_curve_fits.json").read_text())
limits = json.loads((result / "sq_limit_analysis.json").read_text())
opportunities = json.loads((result / "opportunity_analysis.json").read_text())
names = ["Si", "Perovskite", "CIGS"]
pv["tech"] = pv.cell_type.map({"Si_monocrystalline": "Si", "Si": "Si", "c-Si": "Si",
                                "Perovskite": "Perovskite", "CIGS": "CIGS"})
clean = pv.groupby(["tech", "year"], as_index=False).champion_pce_pct.max()
expected = {}


def eq(actual, value):
    if isinstance(value, float):
        assert math.isclose(actual, value, rel_tol=0, abs_tol=1e-9), (actual, value)
    else:
        assert actual == value, (actual, value)


def model(t, saturation, rate, origin):
    return saturation * (-np.expm1(-rate * (t - origin)))


for name, gap in zip(names, [1.12, 1.63, 1.20]):
    part = clean[clean.tech == name].sort_values("year")
    t = part.year.to_numpy(dtype=np.float64)
    y = part.champion_pce_pct.to_numpy(dtype=np.float64)
    # Use the specified expression for fitting; expm1 above is a separate prediction check.
    p, cov = curve_fit(lambda years, sat, r, t0: sat * (1 - np.exp(-r * (years - t0))),
                       t, y, p0=[35, .1, float(t[0])],
                       bounds=([5, .001, 1950], [80, 2, 2025]), maxfev=100000)
    assert np.isfinite(cov).all()
    year = 2024 if (part.year == 2024).any() else int(part.year.max())
    champion = float(part.loc[part.year == year, "champion_pce_pct"].max())
    grid = sorted(sq.itertuples(index=False), key=lambda x: (abs(x.bandgap_eV-gap), x.bandgap_eV))[0]
    sat, rate, origin = (float(x) for x in p)
    headroom = float(grid.sq_limit_pct - champion)
    fraction = float(champion / grid.sq_limit_pct * 100)
    residuals = y - model(t, *p)
    r2 = float(1 - np.dot(residuals, residuals) / np.dot(y-y.mean(), y-y.mean()))
    expected[name] = dict(sat=sat, rate=rate, origin=origin, n=len(part), year=year,
                          champion=champion, sq=float(grid.sq_limit_pct), grid=float(grid.bandgap_eV),
                          target=gap, headroom=headroom, fraction=fraction, r2=r2,
                          sat90=origin+math.log(10)/rate, opportunity=headroom/rate)

assert fits["n_technologies"] == 3
assert [x["technology"] for x in fits["fits"]] == names
assert [x["technology"] for x in limits["technologies"]] == names
assert [x["technology"] for x in opportunities["gap_analysis"]] == names
for name, f, l, g in zip(names, fits["fits"], limits["technologies"], opportunities["gap_analysis"]):
    e = expected[name]
    eq(f["fit_status"], "ok"); eq(f["n_datapoints"], e["n"])
    for field, value, digits in [("eta_sat_pct",e["sat"],2),("r_yr_inv",e["rate"],4),
        ("t0_yr",e["origin"],1),("R2",e["r2"],4),("t_sat90_yr",e["sat90"],1),
        ("champion_efficiency_pct",e["champion"],2)]: eq(f[field],round(value,digits))
    eq(f["champion_year"], e["year"])
    for field, value, digits in [("target_bandgap_eV",e["target"],2),("selected_bandgap_eV",e["grid"],2),
        ("eta_SQ_pct",e["sq"],2),("champion_efficiency_pct",e["champion"],2),
        ("fraction_SQ_pct",e["fraction"],1),("headroom_pct_pts",e["headroom"],1)]: eq(l[field],round(value,digits))
    eq(l["champion_year"],e["year"])
    eq(g["gap_sat_vs_SQ_pct_pts"],round(e["sq"]-e["sat"],2))
    eq(g["eta_sat_above_champion"],e["sat"]>e["champion"])
    eq(g["eta_sat_below_SQ"],e["sat"]<e["sq"])
    eq(g["rank_opportunity"],round(e["opportunity"],1))
    notes = f["notes"].lower()
    for value, low, high in zip([e["sat"],e["rate"],e["origin"]],[5,.001,1950],[80,2,2025]):
        if min(abs(value-low),abs(value-high)) <= 1e-6:
            assert "bound" in notes
    if e["sat"] >= e["sq"]: assert "sq" in notes or "s-q" in notes
headroom_order = sorted(names,key=lambda n:(-expected[n]["headroom"],n))
opportunity_order = sorted(names,key=lambda n:(-expected[n]["opportunity"],n))
eq(limits["ranked_by_headroom"],headroom_order)
eq(opportunities["ranked_by_rank_opportunity"],opportunity_order)
eq(limits["technology_with_max_headroom"],headroom_order[0])
eq(fits["fastest_growth_technology"],sorted(names,key=lambda n:(-expected[n]["rate"],n))[0])
eq(fits["highest_eta_sat_technology"],sorted(names,key=lambda n:(-expected[n]["sat"],n))[0])
rationale = opportunities["conclusions"]["rationale"]
assert len(rationale.split()) >= 200
for name in names: assert name in rationale
assert "cumulative" in rationale.lower() and "physical" in rationale.lower()
expected_answer = "FINAL ANSWER: " + headroom_order[0] + "," + (
    "yes" if expected[headroom_order[0]]["rate"] > expected["Si"]["rate"] else "no")
print(json.dumps({"status":"passed","checked":"numeric fields, rankings, caveat presence, rationale length",
                  "expected_final_answer":expected_answer,"rationale_words":len(rationale.split())},indent=2))

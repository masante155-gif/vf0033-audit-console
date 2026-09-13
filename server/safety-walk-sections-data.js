// Daily Safety Walk — a new, separate checklist done by workers every
// shift (not the weekly GMP audit). Pure worker-safety hazards only, built
// around the OSHA general-industry topics that actually apply to a PET
// water-bottling plant.
//
// Restructured (Sept 2026) to follow the plant's actual walking route, per
// the updated VR-0042-00 Fire Evacuation Plan (the "Safe Walking Area"
// line the plant already uses): stops are ordered the way you'd physically
// walk them, and each distinctly-labeled room on that drawing — Compressor
// & Chiller, Regrind Room, Water In-Process, Husky 1, Husky 2, Preforms —
// is now its own stop instead of being folded into a bigger combined zone.
// The idea is that walking stop-to-stop in this order naturally covers the
// aisles and walkways *between* stops too, not just the labeled rooms, so
// nothing in between gets skipped. "General / Plant-Wide Safety" stays
// first since it's cross-cutting rather than tied to one location.
module.exports = [
  ["General / Plant-Wide Safety", [
    "Primary and secondary emergency exits are unobstructed, unlocked from the inside, and clearly marked with illuminated exit signs.",
    "Evacuation routes and the emergency assembly point are posted and current.",
    "Fire extinguishers are inspected/tagged within the last 12 months, fully charged, unobstructed, and mounted at proper height.",
    "Sprinkler heads and fire alarm pull stations are unobstructed (18-inch clearance) and undamaged.",
    "First aid kit is stocked, accessible, and its contents are within date.",
    "Eyewash/emergency shower stations plant-wide are unobstructed, tested/tagged current, and flush freely.",
    "Aisles, walkways, and stairways are clear of clutter, cords, and slip/trip hazards.",
    "Stairs and elevated platforms have handrails/guardrails in good condition.",
    "Required PPE (safety glasses, hearing protection, gloves, steel-toe boots) is being worn correctly in posted PPE areas.",
    "High-noise areas are posted, and hearing protection is available and used.",
    "SDS binder or electronic HazCom system is accessible and current for every chemical on-site.",
    "Confined-space entry points (tanks, silos, pits) are labeled, and entry follows permit-required confined-space procedure.",
    "Hazard/near-miss reporting log is available and being used.",
  ]],
  ["Compressor & Chiller Area", [
    "No refrigerant or pressurized-air leaks are observed from compressors, chillers, or supply lines.",
    "Air receivers and pressure vessels display a current inspection tag; relief valves are unobstructed and intact.",
    "Guards are in place on belts, pulleys, and fan blades for compressors and chillers.",
    "Lockout/tagout points are identified and used when servicing compressors or chillers.",
    "Refrigerant system placards and labels are present and legible.",
    "Hearing protection is posted/available where compressor noise requires it.",
    "Floor around compressors/chillers is dry and free of refrigerant, oil, or condensate residue.",
  ]],
  ["Regrind Room", [
    "Lockout/tagout procedure is posted and followed before clearing jams or servicing the grinder.",
    "Grinder blades/guards are intact, with no exposed moving parts, and the hopper interlock functions.",
    "Dust collection/deduster is functioning, with no excessive airborne dust buildup.",
    "Area is free of slip/trip hazards from spilled resin or regrind material, and hoses/tools are stored properly rather than left on the floor.",
  ]],
  ["Water In-Process Areas", [
    "No hot-water, RO, or process-line leaks are observed.",
    "Confined-space tanks or silos are labeled, and entry follows permit-required confined-space procedure.",
    "Lockout/tagout points are identified and used when servicing process pumps.",
    "Floors are dry, free of standing water or condensate that could cause a slip.",
  ]],
  ["QA Lab / Chemical Storage", [
    "Chemical containers are labeled per Hazard Communication (product identity + hazard warning), capped, and show no leaks or spills.",
    "SDS sheets are available on-site for every chemical stored or used in this area.",
    "Incompatible chemicals (acids/bases, oxidizers) are segregated per their SDS.",
    "PPE for chemical handling (gloves, goggles, apron) is available at the point of use and being worn.",
    "Eyewash/emergency shower station in this area is unobstructed, tested, and functional.",
    "QA Lab reagents and glassware are stored securely, with lab PPE (goggles, gloves) available and worn during testing.",
  ]],
  ["Husky 1 (Injection — PET 1)", [
    "Machine guards and disconnect panels are in place and secured.",
    "Lockout/tagout procedure is posted and followed before clearing jams or servicing the injection molder.",
    "Barrel/nozzle heater areas carry a burn-hazard warning and are shielded from incidental contact.",
    "Electrical panels and covers are intact with no exposed wiring.",
    "Hoses and tools are stored properly rather than left exposed on or around the machine.",
    "Area around the machine is free of slip/trip hazards from spilled resin, oil, or product.",
  ]],
  ["Dock Space / Warehouse", [
    "Aisles, walkways, and dock areas are clear of trip hazards, spills, and obstructions.",
    "Powered industrial trucks (forklifts) show no fuel/hydraulic/battery leaks and have working horn, lights, and backup alarm.",
    "Only certified operators drive forklifts, and seatbelts are worn.",
    "Racking is labeled with load capacity, and stacked materials are stable, undamaged, and not overloaded.",
    "Dock plates/levelers are secured and rated for the load; trailer wheels are chocked at the dock.",
    "Pedestrian and forklift traffic lanes are marked and kept separate where possible.",
    "Forklift battery-charging area is ventilated, has eyewash access nearby, and posts no smoking/open flame.",
    "PPE for battery servicing (apron, face shield, gloves) is available and used.",
  ]],
  ["Maintenance Shop", [
    "Electrical panels/disconnects have clear working space (36 inches), intact covers, labeled breakers, no exposed wiring.",
    "Hand and power tools are in good condition; damaged tools are tagged out of service.",
    "Lockout/tagout devices and a lockout station are available for equipment serviced here.",
    "Floors are clean, dry, and free of oil, grease, water, condensate, or debris.",
    "Maintenance tools and hoses are stored properly — hoses capped and off the floor when not in use, tools segregated as required.",
    "Lubricants, refrigerants, oils, and maintenance chemicals are properly stored, with containers labeled, capped, and not leaking.",
    "Trash containers are available at points of use, covered where required, and not overflowing.",
    "Walkway in front of the Boneyard/maintenance staging area is clear of debris and obstruction.",
    "Compressed-gas cylinders, if present, are secured upright with caps on when not in use.",
  ]],
  ["Production Line 1 (PET 1)", [
    "Machine guards, light curtains, and door interlocks are in place, undamaged, and functioning.",
    "Point-of-operation nip points, pinch points, and rotating parts are guarded.",
    "Lockout/tagout procedure is posted at the machine and followed for servicing or clearing jams.",
    "E-stops are unobstructed, clearly marked, and tested/functioning.",
    "Electrical control panel covers are intact, with no exposed wiring or bypassed interlocks.",
    "Floors around the line are dry and free of oil, water, or product spill.",
    "Hearing protection is posted/worn where line noise requires it.",
    "Compressed-air lines and fittings show no leaks and are never used to clean clothing or skin.",
  ]],
  ["Production Line 2 (PET 2)", [
    "Machine guards, light curtains, and door interlocks are in place, undamaged, and functioning.",
    "Point-of-operation nip points, pinch points, and rotating parts are guarded.",
    "Lockout/tagout procedure is posted at the machine and followed for servicing or clearing jams.",
    "E-stops are unobstructed, clearly marked, and tested/functioning.",
    "Electrical control panel covers are intact, with no exposed wiring or bypassed interlocks.",
    "Floors around the line are dry and free of oil, water, or product spill.",
    "Hearing protection is posted/worn where line noise requires it.",
    "Compressed-air lines and fittings show no leaks and are never used to clean clothing or skin.",
  ]],
  ["Preforms", [
    "Preform boxes/gaylords are stacked safely, not overloaded, and don't block the aisle or egress path.",
    "Walkway through the Preforms area toward Husky 2 is clear of debris and trip hazards.",
    "Preform dust and plastic fines are swept up regularly rather than left to accumulate on the floor.",
  ]],
  ["Husky 2 (Injection — PET 2)", [
    "Machine guards and disconnect panels are in place and secured.",
    "Lockout/tagout procedure is posted and followed before clearing jams or servicing the injection molder.",
    "Barrel/nozzle heater areas carry a burn-hazard warning and are shielded from incidental contact.",
    "Electrical panels and covers are intact with no exposed wiring.",
    "Hoses and tools are stored properly rather than left exposed on or around the machine.",
    "Area around the machine is free of slip/trip hazards from spilled resin, oil, or product.",
  ]],
  ["Offices / Breakroom / Restrooms", [
    "Egress path near the Ramp and the Ground Zero meeting point is clear, unlocked, and clearly marked.",
    "Office electrical cords and power strips are not daisy-chained or overloaded, and space heaters (if any) have clearance from combustibles.",
    "Breakroom appliances (microwave, refrigerator) are in good condition, and the area is kept clean.",
    "Restrooms are free of slip hazards and standing water.",
  ]],
];

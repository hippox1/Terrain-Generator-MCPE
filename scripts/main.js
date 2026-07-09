import {
    system,
    world,
    BlockPermutation,
    BlockVolume,
    CommandPermissionLevel,
    CustomCommandParamType,
    CustomCommandStatus,
} from "@minecraft/server";

/* ------------------------------------------------------------------ *
 *  Tiny seeded noise system                                          *
 *  (deterministic hash -> smoothed 2D value noise, no dependencies)  *
 * ------------------------------------------------------------------ */

// Deterministic integer hash -> float in [0, 1)
function hashCoords(x, z, seed) {
    let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 2246822519);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
}

function smooth(t) {
    return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

// Smoothed value noise, returns a float in [0, 1)
function valueNoise2D(x, z, seed) {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = x - xi;
    const zf = z - zi;

    const v00 = hashCoords(xi, zi, seed);
    const v10 = hashCoords(xi + 1, zi, seed);
    const v01 = hashCoords(xi, zi + 1, seed);
    const v11 = hashCoords(xi + 1, zi + 1, seed);

    const u = smooth(xf);
    const v = smooth(zf);

    const top = lerp(v00, v10, u);
    const bottom = lerp(v01, v11, u);
    return lerp(top, bottom, v);
}

// Seeded, sequential PRNG for one-off structural decisions (ponds, tree batches...)
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ------------------------------------------------------------------ *
 *  Terrain height: base noise + a second, much slower "roughness"    *
 *  noise field that stretches or flattens the local bump height.     *
 * ------------------------------------------------------------------ */

const NOISE_SCALE = 0.07;
const ROUGHNESS_SCALE = 0.015;
const MIN_LOCAL_AMPLITUDE = 1;

function computeSurfaceY(x, z, seed, minY, maxY, requiredHeight) {
    const midY = Math.floor((minY + maxY) / 2);
    const maxAmplitude = Math.max(1, Math.min(4, Math.floor((maxY - minY) / 4)));

    const roughness = smooth(valueNoise2D(x * ROUGHNESS_SCALE, z * ROUGHNESS_SCALE, seed + 31337));
    const amplitude = lerp(MIN_LOCAL_AMPLITUDE, maxAmplitude, roughness);

    const n = valueNoise2D(x * NOISE_SCALE, z * NOISE_SCALE, seed);
    let surfaceY = Math.round(midY + (n - 0.5) * 2 * amplitude);
    surfaceY = Math.max(minY + requiredHeight, Math.min(maxY - 1, surfaceY));
    return surfaceY;
}

function trySetBlockType(dimension, loc, candidateIds) {
    for (const id of candidateIds) {
        try {
            dimension.setBlockType(loc, id);
            return true;
        } catch (e) {
            // try the next candidate id
        }
    }
    return false;
}

/* ------------------------------------------------------------------ *
 *  Biome definitions                                                 *
 * ------------------------------------------------------------------ */

const BEDROCK_BLOCK = "minecraft:bedrock";
const STONE_BLOCK = "minecraft:stone";
const BEDROCK_MIX_CHANCE = 0.5; // odds a given column's transition block is bedrock vs stone

const BIOME_CONFIG = {
    plains: {
        topLayers: [
            { id: "minecraft:grass_block", count: 1 },
            { id: "minecraft:dirt", count: 3 },
        ],
        requiredHeight: 7, // layers(4) + 3-block bedrock zone + 1 stone buffer above it
    },
    desert: {
        topLayers: [
            { id: "minecraft:sand", count: 3 },
            { id: "minecraft:sandstone", count: 4 },
        ],
        requiredHeight: 10, // layers(7) + 3-block bedrock zone + 1 stone buffer above it
    },
};

/* ------------------------------------------------------------------ *
 *  Column-level terrain fill                                         *
 * ------------------------------------------------------------------ */

// Bedrock floor is three layers: a solid bottom layer, then two layers above it that
// are each independently randomized between bedrock and stone (a thicker transition
// zone, like vanilla's bedrock gradient).
function fillColumnBase(dimension, x, z, surfaceY, minY, topLayers, seed) {
    let y = surfaceY;
    for (const layer of topLayers) {
        const bottomY = y - layer.count + 1;
        if (layer.count === 1) {
            dimension.setBlockType({ x, y, z }, layer.id);
        } else {
            dimension.fillBlocks(new BlockVolume({ x, y: bottomY, z }, { x, y, z }), layer.id);
        }
        y = bottomY - 1;
    }
    // y is now the top of the "stone + bedrock" zone.
    if (y >= minY + 3) {
        dimension.fillBlocks(new BlockVolume({ x, y: minY + 3, z }, { x, y, z }), STONE_BLOCK);
    }
    const mixedBlock2 = hashCoords(x, z, seed + 13231) < BEDROCK_MIX_CHANCE ? BEDROCK_BLOCK : STONE_BLOCK;
    const mixedBlock1 = hashCoords(x, z, seed + 13131) < BEDROCK_MIX_CHANCE ? BEDROCK_BLOCK : STONE_BLOCK;
    dimension.setBlockType({ x, y: minY + 2, z }, mixedBlock2);
    dimension.setBlockType({ x, y: minY + 1, z }, mixedBlock1);
    dimension.setBlockType({ x, y: minY, z }, BEDROCK_BLOCK);
}

function clearAboveSurface(dimension, x, z, fromY, maxY) {
    if (fromY + 1 <= maxY) {
        dimension.fillBlocks(new BlockVolume({ x, y: fromY + 1, z }, { x, y: maxY, z }), "minecraft:air");
    }
}

/* ------------------------------------------------------------------ *
 *  Plains decorations                                                *
 * ------------------------------------------------------------------ */

// Both cut a further 20% from the previous rates (0.18 -> 0.144, 0.01656 -> 0.01325)
const PLAINS_GRASS_TUFT_CHANCE = 0.144;
const PLAINS_TALL_GRASS_SHARE = 0.35;
const PLAINS_FLOWER_CHANCE = 0.01325;

function placeTallGrass(dimension, x, surfaceY, z, maxY) {
    if (surfaceY + 2 > maxY) {
        dimension.setBlockType({ x, y: surfaceY + 1, z }, "minecraft:short_grass");
        return;
    }
    try {
        const lower = BlockPermutation.resolve("minecraft:tall_grass");
        const upper = BlockPermutation.resolve("minecraft:tall_grass", { upper_block_bit: true });
        dimension.setBlockPermutation({ x, y: surfaceY + 1, z }, lower);
        dimension.setBlockPermutation({ x, y: surfaceY + 2, z }, upper);
        return;
    } catch (e) {
        // fall through to the safe fallback below
    }
    dimension.setBlockType({ x, y: surfaceY + 1, z }, "minecraft:short_grass");
}

function decoratePlainsColumn(dimension, x, z, surfaceY, maxY, seed) {
    if (surfaceY + 1 > maxY) return;
    const roll = hashCoords(x, z, seed + 9781);

    if (roll < PLAINS_GRASS_TUFT_CHANCE) {
        const wantsTall = hashCoords(x, z, seed + 5555) < PLAINS_TALL_GRASS_SHARE;
        if (wantsTall) {
            placeTallGrass(dimension, x, surfaceY, z, maxY);
        } else {
            dimension.setBlockType({ x, y: surfaceY + 1, z }, "minecraft:short_grass");
        }
    } else if (roll < PLAINS_GRASS_TUFT_CHANCE + PLAINS_FLOWER_CHANCE) {
        const flower = hashCoords(x, z, seed + 4242) < 0.5 ? "minecraft:poppy" : "minecraft:dandelion";
        dimension.setBlockType({ x, y: surfaceY + 1, z }, flower);
    }
}

/* ------------------------------------------------------------------ *
 *  Desert decorations                                                *
 * ------------------------------------------------------------------ */

// Cactus and deadbush both cut a further 20% (0.008 -> 0.0064, 0.036 -> 0.0288)
const DESERT_CACTUS_CHANCE = 0.0064;
const DESERT_DEADBUSH_CHANCE = 0.0288;

function canPlaceCactus(x, z, surfaceY, seed, minY, maxY, requiredHeight) {
    const neighbors = [
        [x - 1, z],
        [x + 1, z],
        [x, z - 1],
        [x, z + 1],
    ];
    for (const [nx, nz] of neighbors) {
        const neighborSurfaceY = computeSurfaceY(nx, nz, seed, minY, maxY, requiredHeight);
        if (neighborSurfaceY > surfaceY) return false;
    }
    return true;
}

function decorateDesertColumn(dimension, x, z, surfaceY, maxY, seed, minY, requiredHeight) {
    if (surfaceY + 1 > maxY) return;
    const roll = hashCoords(x, z, seed + 9781);

    if (roll < DESERT_CACTUS_CHANCE) {
        if (canPlaceCactus(x, z, surfaceY, seed, minY, maxY, requiredHeight)) {
            const heightRoll = hashCoords(x, z, seed + 2222);
            const cactusHeight = 1 + Math.floor(heightRoll * 3); // 1-3
            for (let i = 1; i <= cactusHeight; i++) {
                if (surfaceY + i > maxY) break;
                dimension.setBlockType({ x, y: surfaceY + i, z }, "minecraft:cactus");
            }
        }
    } else if (roll < DESERT_CACTUS_CHANCE + DESERT_DEADBUSH_CHANCE) {
        trySetBlockType(dimension, { x, y: surfaceY + 1, z }, ["minecraft:deadbush", "minecraft:dead_bush"]);
    }
}

/* ------------------------------------------------------------------ *
 *  Ponds (plains) / lava pools (desert)                              *
 * ------------------------------------------------------------------ */

const WATER_FEATURE_MARGIN = 4;
const WATER_FEATURE_MIN_AREA_SIDE = 20;
const WATER_FEATURE_MIN_GAP = 3;
const MAX_FORCED_FEATURES = 10;
const MAX_FORCED_TREE_BATCHES = 10;
const WATER_FLATNESS_TOLERANCE = 2; // generous now that containment no longer depends on it

// Full grid scan (not perimeter samples) over the feature's footprint AND its ring
// buffer. Returns the min/max terrain height found -- the min becomes the single,
// flat water-surface level for the whole feature, and since it's the MINIMUM over
// the checked area, every ring column is guaranteed to sit at or above the water
// level. That guarantee -- not the flatness tolerance -- is what actually stops
// leaks: a solid ring that's never lower than the water can't be spilled over.
function scanFootprint(cx, cz, checkRadius, seed, minY, maxY, requiredHeight) {
    let min = Infinity;
    let max = -Infinity;
    const r = Math.ceil(checkRadius);
    for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
            const h = computeSurfaceY(cx + dx, cz + dz, seed, minY, maxY, requiredHeight);
            if (h < min) min = h;
            if (h > max) max = h;
        }
    }
    return { min, max };
}

function featuresOverlap(cx, cz, radius, existingFeatures) {
    for (const f of existingFeatures) {
        const d = Math.hypot(cx - f.cx, cz - f.cz);
        if (d < radius + f.radius + WATER_FEATURE_MIN_GAP) return true;
    }
    return false;
}

function planWaterFeatures(
    rng, minX, maxX, minZ, maxZ, minY, maxY, seed, requiredHeight,
    defaultAttemptChance, depthMin, depthMax, forcedCount, extra
) {
    const width = maxX - minX + 1;
    const depthZ = maxZ - minZ + 1;
    const features = [];
    if (width < WATER_FEATURE_MIN_AREA_SIDE || depthZ < WATER_FEATURE_MIN_AREA_SIDE) return features;

    let targetCount;
    if (forcedCount !== undefined && forcedCount !== null) {
        targetCount = Math.max(0, Math.min(MAX_FORCED_FEATURES, forcedCount));
    } else {
        targetCount = rng() < defaultAttemptChance ? 1 : 0;
    }
    if (targetCount === 0) return features;

    const maxTotalAttempts = Math.max(15, targetCount * 25);
    let attempts = 0;
    while (features.length < targetCount && attempts < maxTotalAttempts) {
        attempts++;
        const size = 5 + Math.floor(rng() * 11); // 5-15
        const radius = size / 2;
        const margin = WATER_FEATURE_MARGIN + Math.ceil(radius) + 2;
        if (width <= margin * 2 || depthZ <= margin * 2) continue;

        const cx = Math.round(minX + margin + rng() * (width - 2 * margin));
        const cz = Math.round(minZ + margin + rng() * (depthZ - 2 * margin));
        const maxDepth = depthMin + Math.floor(rng() * (depthMax - depthMin + 1));

        if (featuresOverlap(cx, cz, radius, features)) continue;

        const checkRadius = Math.ceil(radius) + 4; // covers wobble (~1.5) + ring (2) + buffer
        const { min, max } = scanFootprint(cx, cz, checkRadius, seed, minY, maxY, requiredHeight);
        if (max - min <= WATER_FLATNESS_TOLERANCE) {
            features.push({ cx, cz, radius, maxDepth, waterSurfaceY: min, ...extra });
        }
    }
    return features;
}

function featureGeometry(x, z, feature, seed) {
    const dx = x - feature.cx;
    const dz = z - feature.cz;
    const dist = Math.hypot(dx, dz);
    const wobble = (valueNoise2D(x * 0.25, z * 0.25, seed + 555) - 0.5) * 3; // ~ -1.5..1.5
    const effectiveRadius = feature.radius + wobble;
    return { dist, effectiveRadius };
}

function classifyWaterFeaturePoint(x, z, feature, seed) {
    const { dist, effectiveRadius } = featureGeometry(x, z, feature, seed);
    if (dist <= effectiveRadius) return "inside";
    if (dist <= effectiveRadius + 2) return "ring";
    return "outside";
}

function classifyAgainstFeatures(x, z, features, seed) {
    for (const f of features) {
        if (classifyWaterFeaturePoint(x, z, f, seed) === "inside") return { cls: "inside", feature: f };
    }
    for (const f of features) {
        if (classifyWaterFeaturePoint(x, z, f, seed) === "ring") return { cls: "ring", feature: f };
    }
    return { cls: "outside", feature: null };
}

// Shallow at the rim, gradually deeper toward the center -- a bowl, not a flat-bottomed hole.
function localDepthAt(x, z, feature, seed) {
    const { dist, effectiveRadius } = featureGeometry(x, z, feature, seed);
    const normalized = Math.max(0, Math.min(1, 1 - dist / Math.max(effectiveRadius, 0.001)));
    return Math.max(1, Math.round(1 + normalized * (feature.maxDepth - 1)));
}

/* ------------------------------------------------------------------ *
 *  Trees (plains only)                                               *
 * ------------------------------------------------------------------ */

const TREE_MARGIN = 5;
const TREE_MIN_SPACING = 2; // Chebyshev distance; keeps a clear 3x3 around every trunk
const TREE_PLACEMENT_ATTEMPTS = 6;

function isFarEnoughFromTrees(tx, tz, existingTrees) {
    for (const t of existingTrees) {
        if (Math.max(Math.abs(tx - t.x), Math.abs(tz - t.z)) < TREE_MIN_SPACING) return false;
    }
    return true;
}

function planTreeBatches(rng, minX, maxX, minZ, maxZ, waterFeatures, seed, forcedBatchCount) {
    const width = maxX - minX + 1;
    const depthZ = maxZ - minZ + 1;
    const area = width * depthZ;
    if (width <= TREE_MARGIN * 2 + 2 || depthZ <= TREE_MARGIN * 2 + 2) return [];

    let numBatches;
    if (forcedBatchCount !== undefined && forcedBatchCount !== null) {
        numBatches = Math.max(0, Math.min(MAX_FORCED_TREE_BATCHES, forcedBatchCount));
    } else {
        numBatches = 0;
        if (area >= 300 && rng() < 0.72) numBatches = 1;
        if (numBatches === 1 && area >= 3000 && rng() < 0.6) numBatches = 2;
    }

    const trees = [];
    for (let b = 0; b < numBatches; b++) {
        const anchorX = Math.round(minX + TREE_MARGIN + rng() * (width - 2 * TREE_MARGIN));
        const anchorZ = Math.round(minZ + TREE_MARGIN + rng() * (depthZ - 2 * TREE_MARGIN));
        const treeCount = 1 + Math.floor(rng() * 6); // 1-6

        for (let t = 0; t < treeCount; t++) {
            for (let attempt = 0; attempt < TREE_PLACEMENT_ATTEMPTS; attempt++) {
                const dx = Math.round((rng() - 0.5) * 10);
                const dz = Math.round((rng() - 0.5) * 10);
                let tx = anchorX + dx;
                let tz = anchorZ + dz;
                tx = Math.max(minX + 2, Math.min(maxX - 2, tx));
                tz = Math.max(minZ + 2, Math.min(maxZ - 2, tz));

                if (!isFarEnoughFromTrees(tx, tz, trees)) continue;
                if (waterFeatures.length > 0 && classifyAgainstFeatures(tx, tz, waterFeatures, seed).cls !== "outside")
                    continue;

                const height = 4 + Math.floor(rng() * 3); // 4, 5, or 6
                trees.push({ x: tx, z: tz, height });
                break;
            }
        }
    }
    return trees;
}

// Deterministic "is this leaf position cut away" roll, folding y into the hash so
// each canopy layer gets its own independent pattern.
function leafCutRoll(bx, y, bz, seed, salt) {
    return hashCoords(bx, y * 100003 + bz, seed + salt);
}

function shouldPlaceLeaf(bx, y, bz, dx, dz, radius, seed, cornerCutChance, edgeCutChance) {
    if (dx === 0 && dz === 0) return true;
    const isCorner = Math.abs(dx) === radius && Math.abs(dz) === radius;
    if (isCorner) return leafCutRoll(bx, y, bz, seed, 8801) >= cornerCutChance;
    const isOuterEdge = Math.max(Math.abs(dx), Math.abs(dz)) === radius;
    if (isOuterEdge && edgeCutChance > 0) return leafCutRoll(bx, y, bz, seed, 8802) >= edgeCutChance;
    return true;
}

function* placeTrees(dimension, trees, surfaceYAt, seed) {
    if (trees.length === 0) return;

    const logPositions = new Set();
    const treeData = [];

    // Pass 1: trunks first, so leaf placement (pass 2) knows what NOT to overwrite.
    for (const tree of trees) {
        const surfaceY = surfaceYAt(tree.x, tree.z);
        const topLogY = surfaceY + tree.height;
        dimension.fillBlocks(
            new BlockVolume({ x: tree.x, y: surfaceY + 1, z: tree.z }, { x: tree.x, y: topLogY, z: tree.z }),
            "minecraft:oak_log"
        );
        for (let y = surfaceY + 1; y <= topLogY; y++) {
            logPositions.add(`${tree.x},${y},${tree.z}`);
        }
        treeData.push({ ...tree, surfaceY, topLogY });
        yield;
    }

    // Pass 2: leaves -- 4 main layers: bottom two 5x5, top two 3x3. Only diagonal
    // corners are ever cut (more aggressively on the 3x3 layers); the 4 orthogonal
    // neighbors of the trunk are never cut, so a log never gets exposed at its own
    // height. A cut corner on the lower 3x3 layer is never re-grown on the 3x3
    // layer above it, so there's never a leaf floating with nothing under it.
    // Height-4 trees always use the short canopy start; height-6 always starts
    // higher; height-5 trees randomly pick either, for variety. Whenever that
    // leaves the top log's own layer uncovered, an extra heavily-cut 3x3 cap gets
    // added above it (with the center always kept, so the log is never bare).
    for (const tree of treeData) {
        let leafBaseY;
        if (tree.height === 4) {
            leafBaseY = tree.surfaceY + 2;
        } else if (tree.height === 6) {
            leafBaseY = tree.surfaceY + 4;
        } else {
            // height 5: randomly borrow the height-4 or height-6 canopy start.
            const useTallStart = hashCoords(tree.x, tree.z, seed + 6161) < 0.5;
            leafBaseY = tree.surfaceY + (useTallStart ? 4 : 2);
        }
        const leafTopY = leafBaseY + 3; // 4 main layers, always

        // Tracks which diagonal corners were cut in the lower of the two 3x3 layers,
        // so the layer above it never places a leaf with nothing supporting it below.
        let lowerRadius1Cuts = null;

        for (let y = leafBaseY; y <= leafTopY; y++) {
            const i = y - leafBaseY; // 0 = bottom-most leaf layer
            const radius = i < 2 ? 2 : 1;
            const cornerCutChance = i < 2 ? 0.45 : 0.6;
            const thisLayerCuts = radius === 1 ? new Set() : null;

            for (let dx = -radius; dx <= radius; dx++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    const bx = tree.x + dx;
                    const bz = tree.z + dz;
                    const key = `${bx},${y},${bz}`;
                    if (logPositions.has(key)) continue;

                    const forcedCut = radius === 1 && lowerRadius1Cuts !== null && lowerRadius1Cuts.has(`${dx},${dz}`);
                    // edgeCutChance is 0 -- only true diagonal corners are ever cut.
                    const place = !forcedCut && shouldPlaceLeaf(bx, y, bz, dx, dz, radius, seed, cornerCutChance, 0);

                    if (!place) {
                        if (thisLayerCuts) thisLayerCuts.add(`${dx},${dz}`);
                        continue;
                    }
                    dimension.setBlockType({ x: bx, y, z: bz }, "minecraft:oak_leaves");
                }
            }
            if (radius === 1) lowerRadius1Cuts = thisLayerCuts;
        }

        // If the 4 main layers don't reach above the top log (only possible for a
        // height-5 tree using the short canopy start), the log's own top face would
        // otherwise be bare. Add one more, more heavily cut 3x3 layer right above
        // it -- corners AND edges can be cut here since there's no log left to
        // expose, but the center is always kept (shouldPlaceLeaf never cuts dx=dz=0).
        if (leafTopY <= tree.topLogY) {
            const cappingY = tree.topLogY + 1;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const bx = tree.x + dx;
                    const bz = tree.z + dz;
                    if (logPositions.has(`${bx},${cappingY},${bz}`)) continue;
                    if (!shouldPlaceLeaf(bx, cappingY, bz, dx, dz, 1, seed, 0.75, 0.45)) continue;
                    dimension.setBlockType({ x: bx, y: cappingY, z: bz }, "minecraft:oak_leaves");
                }
            }
        }

        yield;
    }
}

/* ------------------------------------------------------------------ *
 *  Top-level generation job                                          *
 * ------------------------------------------------------------------ */

function* generateTerrain(dimension, minX, maxX, minZ, maxZ, minY, maxY, seed, biome, forcedWaterCount, forcedTreeBatches) {
    const biomeCfg = BIOME_CONFIG[biome];
    const rng = mulberry32(seed);

    let waterFeatures = [];
    if (biome === "plains") {
        waterFeatures = planWaterFeatures(
            rng, minX, maxX, minZ, maxZ, minY, maxY, seed, biomeCfg.requiredHeight, 0.6, 1, 2, forcedWaterCount,
            {
                liquidBlock: "minecraft:water",
                ringPrimaryBlock: "minecraft:gravel",
                ringSecondaryBlock: "minecraft:grass_block",
                ringPrimaryChance: 0.72,
            }
        );
    } else if (biome === "desert") {
        waterFeatures = planWaterFeatures(
            rng, minX, maxX, minZ, maxZ, minY, maxY, seed, biomeCfg.requiredHeight, 0.5, 1, 3, forcedWaterCount,
            {
                liquidBlock: "minecraft:lava",
                ringPrimaryBlock: "minecraft:stone",
                ringSecondaryBlock: "minecraft:sand",
                ringPrimaryChance: 0.82,
            }
        );
    }

    for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
            const surfaceY = computeSurfaceY(x, z, seed, minY, maxY, biomeCfg.requiredHeight);
            fillColumnBase(dimension, x, z, surfaceY, minY, biomeCfg.topLayers, seed);

            const { cls, feature } = classifyAgainstFeatures(x, z, waterFeatures, seed);
            let handled = false;

            if (cls === "inside") {
                const waterTop = feature.waterSurfaceY;
                // Clear from whichever is lower (own ground or the flat water level) so no
                // stray bump can poke out above the pond's single, level water surface.
                clearAboveSurface(dimension, x, z, Math.min(surfaceY, waterTop), maxY);
                const depth = localDepthAt(x, z, feature, seed);
                const bottom = Math.max(minY + 3, waterTop - depth + 1);
                dimension.fillBlocks(new BlockVolume({ x, y: bottom, z }, { x, y: waterTop, z }), feature.liquidBlock);
                handled = true;
            } else if (cls === "ring") {
                // Ring columns keep their own (guaranteed-flat-enough, guaranteed >= water level) height.
                clearAboveSurface(dimension, x, z, surfaceY, maxY);
                const useAlt = hashCoords(x, z, seed + 3131) < feature.ringPrimaryChance;
                const blockId = useAlt ? feature.ringPrimaryBlock : feature.ringSecondaryBlock;
                dimension.setBlockType({ x, y: surfaceY, z }, blockId);
                handled = true;
            } else {
                clearAboveSurface(dimension, x, z, surfaceY, maxY);
            }

            if (!handled) {
                if (biome === "plains") {
                    decoratePlainsColumn(dimension, x, z, surfaceY, maxY, seed);
                } else {
                    decorateDesertColumn(dimension, x, z, surfaceY, maxY, seed, minY, biomeCfg.requiredHeight);
                }
            }

            yield;
        }
    }

    let treeCountPlaced = 0;
    if (biome === "plains") {
        const trees = planTreeBatches(rng, minX, maxX, minZ, maxZ, waterFeatures, seed, forcedTreeBatches);
        if (trees.length > 0) {
            treeCountPlaced = trees.length;
            yield* placeTrees(
                dimension, trees,
                (x, z) => computeSurfaceY(x, z, seed, minY, maxY, biomeCfg.requiredHeight),
                seed
            );
        }
    }

    const featureWord = biome === "plains" ? "pond" : "lava pool";
    let featureNote = "";
    if (waterFeatures.length > 0) {
        featureNote = `, ${waterFeatures.length} ${featureWord}${waterFeatures.length > 1 ? "s" : ""}`;
    }
    if (forcedWaterCount !== undefined && forcedWaterCount !== null && waterFeatures.length !== forcedWaterCount) {
        featureNote += ` (requested ${forcedWaterCount})`;
    }
    const treeNote = treeCountPlaced > 0 ? `, ${treeCountPlaced} trees` : "";
    world.sendMessage(`§aTerrain generation complete! (biome: ${biome}${featureNote}${treeNote}, seed: ${seed})`);
}

/* ------------------------------------------------------------------ *
 *  Generation speed                                                  *
 * ------------------------------------------------------------------ */

// runJob's per-tick budget is time-based and engine-controlled, so it isn't
// something we can dial directly. Instead, we drive the generator ourselves:
// process a fixed number of "steps" (each `yield` in generateTerrain/placeTrees
// counts as one step, whether it's a column or a tree) synchronously, then
// either move straight to the next tick (fast) or wait a few extra ticks
// (normal/low) before continuing. Bigger columnsPerBatch + smaller
// ticksBetweenBatches = faster but more demanding per tick; smaller batches +
// longer waits = slower but much gentler on low-end devices/servers.
const SPEED_PROFILES = {
    low: { columnsPerBatch: 15, ticksBetweenBatches: 3 },
    normal: { columnsPerBatch: 60, ticksBetweenBatches: 1 },
    fast: { columnsPerBatch: 300, ticksBetweenBatches: 0 },
};
const DEFAULT_SPEED = "fast"; // matches the original (pre-speed-option) behavior

function runGeneratorPaced(generator, profile) {
    function step() {
        let result;
        for (let i = 0; i < profile.columnsPerBatch; i++) {
            result = generator.next();
            if (result.done) return;
        }
        if (profile.ticksBetweenBatches > 0) {
            system.runTimeout(step, profile.ticksBetweenBatches);
        } else {
            system.run(step); // still yields to the next tick, just with no extra wait
        }
    }
    step();
}

/* ------------------------------------------------------------------ *
 *  Custom command registration                                       *
 * ------------------------------------------------------------------ */

const MAX_COLUMNS = 40000;

function resolveForcedCount(value) {
    if (value === undefined || value === null || value < 0) return undefined;
    return value;
}

system.beforeEvents.startup.subscribe((init) => {
    init.customCommandRegistry.registerEnum("terrain:biome", ["plains", "desert"]);
    init.customCommandRegistry.registerEnum("terrain:speed", ["low", "normal", "fast"]);

    init.customCommandRegistry.registerCommand(
        {
            name: "terrain:generate",
            description: "Generates noise-based terrain (plains or desert) between two corners.",
            permissionLevel: CommandPermissionLevel.GameDirectors,
            mandatoryParameters: [
                { type: CustomCommandParamType.Location, name: "from" },
                { type: CustomCommandParamType.Location, name: "to" },
                { type: CustomCommandParamType.Enum, name: "terrain:biome" },
            ],
            optionalParameters: [
                { type: CustomCommandParamType.Integer, name: "seed" },
                { type: CustomCommandParamType.Integer, name: "waterFeatures" },
                { type: CustomCommandParamType.Integer, name: "treeBatches" },
                { type: CustomCommandParamType.Enum, name: "terrain:speed" },
            ],
        },
        (origin, from, to, biome, seed, waterFeatures, treeBatches, speed) => {
            const dimension = origin.sourceEntity?.dimension ?? world.getDimension("overworld");
            const biomeCfg = BIOME_CONFIG[biome];

            const usedSeed =
                seed !== undefined && seed !== null && seed >= 0 ? seed : Math.floor(Math.random() * 2147483647);
            const forcedWaterCount = resolveForcedCount(waterFeatures);
            const forcedTreeBatches = resolveForcedCount(treeBatches);
            const resolvedSpeed = speed && SPEED_PROFILES[speed] ? speed : DEFAULT_SPEED;

            const minX = Math.floor(Math.min(from.x, to.x));
            const maxX = Math.floor(Math.max(from.x, to.x));
            const minY = Math.floor(Math.min(from.y, to.y));
            const maxY = Math.floor(Math.max(from.y, to.y));
            const minZ = Math.floor(Math.min(from.z, to.z));
            const maxZ = Math.floor(Math.max(from.z, to.z));

            if (maxY - minY < biomeCfg.requiredHeight + 1) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: `The area needs to be at least ${biomeCfg.requiredHeight + 1} blocks tall for the ${biome} biome (layers + stone + 3-block bedrock transition).`,
                };
            }

            const columns = (maxX - minX + 1) * (maxZ - minZ + 1);
            if (columns > MAX_COLUMNS) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: `Area too large (${columns} columns). Please pick an area under ${MAX_COLUMNS} columns.`,
                };
            }

            system.run(() => {
                const generator = generateTerrain(
                    dimension, minX, maxX, minZ, maxZ, minY, maxY, usedSeed, biome, forcedWaterCount, forcedTreeBatches
                );
                runGeneratorPaced(generator, SPEED_PROFILES[resolvedSpeed]);
            });

            return {
                status: CustomCommandStatus.Success,
                message: `Generating ${columns}-column ${biome} terrain (seed: ${usedSeed}, speed: ${resolvedSpeed})...`,
            };
        }
    );
});

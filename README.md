# Terrain-Generator-MCPE
Fully Scripts based for generating terrain for mcpe using Javascripts.
<img width="1898" height="1081" alt="image" src="https://github.com/user-attachments/assets/43999ce0-f770-44ce-ac43-9566aee77677" />
<img width="1855" height="1047" alt="image" src="https://github.com/user-attachments/assets/13078c58-afbe-4ffc-bd90-2edc38a54668" />

Using command or function in script to generate terrain inside Minecraft:

/generate (from) (to) (biome) [seed optional] [waterFeature] [treeBatches] [speed]

The limit for generate is 200x200 area, for not lagging the world. (recommend to generate a 90-100x area).

- waterFeature: determine the number of water/lava pool.
- treeBatches: determine the number of tree batches, each batch contains around 5 trees.
- speed: the speed for generation, from low, normal to fast.

-1 is random, 0 is none, 1-10 is the requested number for features.

Usage:

/generate 50 0 50 -50 30 -50 plains (random seed plains)

/generate ~ ~ ~ ~90 ~30 ~90 plains 78723786 3 6 (predetermined seed with 3 water pools and 6 tree batches)

/generate ~ ~ ~ ~90 ~30 ~90 desert -1 4 (random seed desert with 4 lava pools)

https://www.curseforge.com/minecraft-bedrock/addons/terrain-generator

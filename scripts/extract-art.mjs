/** Copy original art and extract declarative atlas coordinates; never execute the APK bundle. */
import fs from "node:fs";
import crypto from "node:crypto";
const source = "research/extracted/assets/public/assets/";
const code = fs.readFileSync(
  "research/analysis/javascript/index-DgdyVR_2.js",
  "utf8",
);
const frames = JSON.parse(code.match(/O8e = JSON\.parse\('([^']+)'\)/)[1]);
if (!frames.GeneratorFill)
  throw Error("Unexpected atlas layout");
const output = "packages/client/public/assets/original/";
fs.mkdirSync(output, { recursive: true });
const assets = [
  "GameElements-Qt-7shUI.png",
  "SpecialistAtlas-BQysp94a.png",
  "Sea-8Q-aXb55.png",
].map((file) => {
  const data = fs.readFileSync(source + file);
  fs.writeFileSync(output + file, data);
  return {
    file,
    source: source + file,
    bytes: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
  };
});
fs.writeFileSync(
  output + "manifest.json",
  JSON.stringify(
    {
      source: "Subterfuge APK 12075; see research/provenance.json",
      transformed: false,
      assets,
    },
    null,
    2,
  ) + "\n",
);
fs.writeFileSync(
  "packages/client/src/original-art.generated.ts",
  "// Extracted frame coordinates from APK 12075; images remain unchanged.\nexport const gameFrames = " +
    JSON.stringify(
      Object.fromEntries(Object.entries(frames).map(([k, v]) => [k, v.frame])),
      null,
      2,
    ) +
    ";\n",
);
console.log(
  `Copied ${assets.length} original images; extracted ${Object.keys(frames).length} game frames.`,
);

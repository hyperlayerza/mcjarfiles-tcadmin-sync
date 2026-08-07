// mcjarfiles.com type/variant catalogue for Minecraft JAVA server software.
// Bedrock is intentionally excluded — it's not a Java server and needs a
// different (non-jar) install flow.
//
// `type` and `variant` are the path segments mcjarfiles.com expects:
//   /api/get-versions/{type}/{variant}
//   /api/get-jar/{type}/{variant}/{version}

export interface McVariant {
  type: string;
  variant: string;
  /** TCAdmin Update `groupName` — how it's grouped in the customer UI. */
  groupName: string;
  /** TCAdmin Update `icon` — image URL shown next to every version in this group. */
  icon: string;
}

// Icon sources: the official project's own favicon/logo where practical, or
// the selfh.st/icons open icon set (served off jsdelivr's CDN, backed by
// GitHub) for projects without a clean standalone favicon. Same icons
// mcjarfiles.com itself uses on its server-type cards.
export const DEFAULT_VARIANTS: McVariant[] = [
  { type: "vanilla", variant: "release", groupName: "Vanilla", icon: "https://www.minecraft.net/etc.clientlibs/minecraftnet/clientlibs/clientlib-site/resources/favicon.ico" },
  { type: "servers", variant: "paper", groupName: "Paper", icon: "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/papermc.svg" },
  { type: "servers", variant: "purpur", groupName: "Purpur", icon: "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/purpurmc.svg" },
  { type: "servers", variant: "leafmc", groupName: "Leaf", icon: "https://github.com/Winds-Studio.png" },
  { type: "servers", variant: "folia", groupName: "Folia", icon: "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/papermc-folia.svg" },
  { type: "modded", variant: "fabric", groupName: "Fabric", icon: "https://fabricmc.net/assets/favicon.png" },
  { type: "proxies", variant: "velocity", groupName: "Velocity", icon: "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/papermc-velocity.svg" },
  // Off by default — snapshots churn daily and are rarely what a customer
  // wants one-click access to. Add "vanilla/snapshot" to
  // MCJARFILES_VARIANTS to include it.
];

const ALL_KNOWN: McVariant[] = [
  ...DEFAULT_VARIANTS,
  { type: "vanilla", variant: "snapshot", groupName: "Vanilla Snapshots", icon: "https://www.minecraft.net/etc.clientlibs/minecraftnet/clientlibs/clientlib-site/resources/favicon.ico" },
];

/** Parses the MCJARFILES_VARIANTS env var ("type/variant,type/variant"). */
export function resolveVariants(envValue: string | undefined): McVariant[] {
  if (!envValue || envValue.trim() === "") {
    return DEFAULT_VARIANTS;
  }

  const requested = envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const resolved: McVariant[] = [];
  for (const key of requested) {
    const [type, variant] = key.split("/").map((s) => s.trim());
    const match = ALL_KNOWN.find((v) => v.type === type && v.variant === variant);
    if (!match) {
      throw new Error(
        `Unknown MCJARFILES_VARIANTS entry "${key}". Expected one of: ${ALL_KNOWN.map((v) => `${v.type}/${v.variant}`).join(", ")}`
      );
    }
    resolved.push(match);
  }
  return resolved;
}

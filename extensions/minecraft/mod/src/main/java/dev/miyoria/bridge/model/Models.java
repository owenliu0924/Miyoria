package dev.miyoria.bridge.model;

/** Plain data carriers (no Minecraft types) shared by the observer, summarizer and event detector. */
public final class Models {
    private Models() {}

    /**
     * A nearby entity. {@code type} is a normalized id ("zombie"), {@code name} the display name,
     * {@code position} the block it stands in (null when unknown).
     */
    public record EntityInfo(String type, String name, double distance, boolean hostile, Pos position) {
        public EntityInfo(String type, String name, double distance, boolean hostile) {
            this(type, name, distance, hostile, null);
        }
    }

    /** An item stack. {@code durabilityPct} is null for non-damageable items. */
    public record StackInfo(String item, int count, Integer durabilityPct) {}

    /** A block position + id, e.g. one scanned notable block. */
    public record BlockInfo(String block, int x, int y, int z, double distance) {}

    public record Pos(int x, int y, int z) {}
}

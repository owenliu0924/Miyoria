// The per-machine supervisor. Parts are added step by step (docs/design/v5-hostd.md).
export {
  CATALOG_ROOTS,
  type Catalog,
  type CatalogEntry,
  type CatalogProblem,
  DESCRIPTOR_FILE,
  loadCatalog,
  PLACEHOLDERS,
  placeholdersIn,
} from "./catalog.js";

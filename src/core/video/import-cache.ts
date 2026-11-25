import { Directory, Paths } from "expo-file-system";

let imports: Directory | undefined;

export function videoImportDirectory() {
  if (imports) return imports;
  const directory = new Directory(Paths.cache, "video-imports");
  if (directory.exists) directory.delete();
  imports = directory;
  return directory;
}

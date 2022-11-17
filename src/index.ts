import { Block, parse as CommentParser } from "comment-parser";
import axios from "axios";
import crypto from "crypto";
import VinylFS from "vinyl-fs";
import File from "vinyl";
import fs from "fs";

/**
 * Applies any number of transformations to the Axios response content
 * so that future fetches of the same url will generate the same hash.
 *
 * I.e. remove nonce values from the DOM (since these change with each page load)
 *
 */
type FilterFunction = (content: string) => string;

type FilterFunctions = Record<string, FilterFunction>;

export type ExternalDocumentRecord = {
  Path: string;
  BaseName: string;
  ExternalDocSource: string;
  SavedExternalDocHash: string;
  CurrentExternalDocHash: string;
  Matches: boolean;
};

const TS_DOC_TAG_NAME = "ExternalDocSource";

let shouldUpdateFiles: boolean = true;

let URLCaches: Record<string, string | Promise<string>> = {};
let allFilters: FilterFunctions = {
  body: (content: string) => {
    const bodyRegex = new RegExp(/(<body[\s\S]*?<\/body.*?>)/gim);
    const bodyMatches = bodyRegex.exec(content);
    if (bodyMatches == null || bodyMatches[1] == null) {
      return content;
    }
    return content[1];
  }
};

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}
function UpdateDocsInFile(file: File, docs: ExternalDocumentRecord[]) {
  if (!file.contents) {
    return;
  }
  let fileContents = file.contents.toString();
  docs.forEach((doc) => {
    const regex = new RegExp(`\\*.*?@${TS_DOC_TAG_NAME}.*?${escapeRegExp(doc.ExternalDocSource)}.*?$`, "gim");
    fileContents = fileContents.replace(
      regex,
      `* @${TS_DOC_TAG_NAME} {${doc.CurrentExternalDocHash}} ${doc.ExternalDocSource}`
    );
  });
  fs.writeFileSync(file.path, fileContents);
}

export function SetExternalDocumentFilters(filters: FilterFunctions) {
  allFilters = {
    ...allFilters,
    ...filters
  };
}

export async function GetURLHash(url: string, filters: string[]) {
  if (URLCaches.hasOwnProperty(url)) {
    if (typeof URLCaches[url] == "string") {
      //log("using cached url hash" + url)
      return URLCaches[url];
    } else if (typeof URLCaches[url].hasOwnProperty("then")) {
      //log("waiting for cached url hash promise"+ url)
      return await URLCaches[url];
    }
  }

  const pagePromise = axios({
    url: url
  })
    .then((d) => {
      try {
        if (typeof d.data != "string") {
          return "Non-string returned: " + d.data;
        }
        let pageData = d.data;
        let filtersApplied = [];
        for (let f of filters) {
          if (typeof allFilters[f] == "function") {
            let newData = allFilters[f](pageData);
            if (newData != pageData) {
              filtersApplied.push(f);
              pageData = newData;
            }
          }
        }

        return (
          crypto.createHash("sha256").update(pageData).digest("hex").substring(0, 6) +
          (filtersApplied.length > 0 ? "-" + filtersApplied.join(",") : "")
        );
      } catch (err) {
        console.log("error", err);
        return "Unable to hash page: " + err.message;
      }
    })
    .catch((urlError) => {
      return "BAD URL: " + urlError.message;
    });
  URLCaches[url] = pagePromise;
  //log("using new url hash promise"+ url)
  return pagePromise;
}

export async function CheckGlobDocs(glob: string): Promise<ExternalDocumentRecord[]> {
  let allDocs: Promise<ExternalDocumentRecord[]>[] = []
  return new Promise<ExternalDocumentRecord[]>((resolve, reject) => {
    VinylFS.src(glob)
      .on("data", async (d: File) => {
        if (d.contents == null) {
          // Skip directories
          return;
        }
        allDocs.push(CheckFileDocs(d));
      })
      .on("end", async () => {
        let temp = (await Promise.all(allDocs)).flatMap(x=>x)
        resolve(temp);
      });
  });
}

export async function CheckFileDocs(file: File): Promise<ExternalDocumentRecord[]> {
  let comments: Block[];
  const fileContents = file.contents?.toString();
  if (!fileContents) {
    throw new Error("File content is not readable");
  }
  try {
    comments = CommentParser(fileContents);
  } catch (err) {
    throw new Error("Failed to parse comments for file " + file.path + ": " + err.message);
  }

  const externalDocs = comments
    .flatMap((c) => c.tags)
    .filter((tag) => tag.tag == TS_DOC_TAG_NAME)
    .map(async (DocSourceTag): Promise<ExternalDocumentRecord> => {
      let pd: ExternalDocumentRecord = {
        Path: file.path,
        BaseName: file.basename,
        ExternalDocSource: DocSourceTag.name,
        SavedExternalDocHash: DocSourceTag.type,
        CurrentExternalDocHash: "",
        Matches: false
      };
      let filters: string[] = [];
      if (pd.SavedExternalDocHash.split("-").length >= 2) {
        filters = pd.SavedExternalDocHash.split("-")[1].split(",");
      }
      pd.CurrentExternalDocHash = await GetURLHash(pd.ExternalDocSource, filters);
      pd.Matches = pd.SavedExternalDocHash == pd.CurrentExternalDocHash;
      return pd;
    });

  const allDocs = await Promise.all(externalDocs);
  if (shouldUpdateFiles) {
    UpdateDocsInFile(file, allDocs);
  }
  return allDocs;
}

import { Block, parse as CommentParser } from "comment-parser";
import axios, { AxiosHeaders, AxiosResponse } from "axios";
import crypto from "crypto";
import VinylFS from "vinyl-fs";
import File from "vinyl";
import fs from "fs";
import cloudscraper from "cloudscraper"
import { baseFilters, FilterFunctions } from "./filters";
export { FilterFunction } from "./filters";

let allFilters: FilterFunctions = baseFilters;

export type ExternalDocumentRecord = {
  Path: string;
  BaseName: string;
  ExternalDocSource: string;
  SavedExternalDocHash: string;
  CurrentExternalDocHash: string;
  Matches: boolean;
};

type URLCacheRecord = {
  filtersApplied: string[];
  filteredContent: string;
  hash: string;
  isCacheRecord: boolean;
  isError?: boolean;
};

function isURLCacheRecord(o: any): o is URLCacheRecord {
  return (o as URLCacheRecord).isCacheRecord == true;
}

const TS_DOC_TAG_NAME = "ExternalDocSource";
const TS_DOC_CACHE_DIR = ".tsdoc-link-cache";
const USER_AGENT_HEADER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:107.0) Gecko/20100101 Firefox/107.0";

let shouldUpdateFiles: boolean = true;
let shouldCacheResponses: boolean = true;

let URLCaches: Record<string, URLCacheRecord | Promise<URLCacheRecord>> = {};


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
    ...baseFilters,
    ...filters
  };
}

async function BestEffortURLScrape(url: string): Promise<string> {
  let headers = {
    "User-Agent": USER_AGENT_HEADER,
    "Accept-Language": "en-US,en;q=0.5",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site"
  };
  try {
    let response = await axios({ 
      headers: headers,
      url: url 
    });
    return response.data
  } catch (urlError) {
    try {
      // Some sites are on CloudFlare which blocks Axios requests; fall back to cloudscraper
      let response = await cloudscraper({
        headers: headers,
        url: url,
        method: "GET"
      })
      return response
    }
    catch (err) {
      throw "Failed to fetch url"
    }
  }
}

export async function GetURLHash(url: string, filters: string[]): Promise<URLCacheRecord> {

  const hashKey = crypto.createHash("sha256").update(url+filters.join(",")).digest("hex").substring(0, 6)
  if (URLCaches.hasOwnProperty(hashKey)) {
    if (isURLCacheRecord(URLCaches)) {
      return URLCaches[hashKey];
    } else if (URLCaches[hashKey].hasOwnProperty("then")) {
      return await (URLCaches[hashKey] as Promise<URLCacheRecord>);
    }
  }

  URLCaches[hashKey] = new Promise<URLCacheRecord>(async (resolve, reject) => {
    let pageData: string = "";
    let filtersApplied: string[] = [];
  
    try {
      pageData = await BestEffortURLScrape(url)
    }
    catch(err) {
      return resolve({
        filteredContent: "",
        filtersApplied: [],
        hash: "Failed to scrape URL: " + err.message,
        isCacheRecord: true,
        isError: true
      });
    }

    try {
      if (typeof(pageData) != "string") {
        return resolve({
          filteredContent: "",
          filtersApplied: [],
          hash: "Non-string returned",
          isCacheRecord: true,
          isError: true
        });
      }
      for (let f of filters) {
        if (typeof allFilters[f] != "function") {
          continue;
        }
        let newData = allFilters[f](pageData);
        if (newData != pageData) {
          filtersApplied.push(f);
          pageData = newData;
         
        }
      }
    } catch (err) {
      return resolve({
        filteredContent: pageData,
        filtersApplied: filtersApplied,
        hash: "Unable to hash page: " + err.message,
        isCacheRecord: true,
        isError: true
      });
    }

    const hash =
      crypto.createHash("sha256").update(pageData).digest("hex").substring(0, 6) +
      (filtersApplied.length > 0 ? "-" + filtersApplied.join(",") : "");
      return resolve({
        filteredContent: pageData,
        hash: hash,
        isCacheRecord: true,
        filtersApplied: filtersApplied
      });
      //log("using new url hash promise"+ url)
  });
  return URLCaches[hashKey];
}

export async function CheckGlobDocs(glob: string): Promise<ExternalDocumentRecord[]> {
  let allDocs: Promise<ExternalDocumentRecord[]>[] = [];
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
        let temp = (await Promise.all(allDocs)).flatMap((x) => x);
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
      const hashRecord = await GetURLHash(pd.ExternalDocSource, filters);
      if (shouldCacheResponses && ! hashRecord.isError) {
        try {
          fs.mkdirSync(`${TS_DOC_CACHE_DIR}`);
        }
        catch (err){}
        fs.writeFileSync(`${TS_DOC_CACHE_DIR}/${hashRecord.hash}.html`,hashRecord.filteredContent);
      }
      pd.CurrentExternalDocHash = hashRecord.hash
      pd.Matches = ! hashRecord.isError && pd.SavedExternalDocHash == pd.CurrentExternalDocHash;
      return pd;
    });

  const allDocs = await Promise.all(externalDocs);
  if (shouldUpdateFiles) {
    UpdateDocsInFile(file, allDocs);
  }
  return allDocs;
}

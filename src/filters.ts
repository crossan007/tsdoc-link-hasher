import { decode } from 'html-entities';

/**
 * Applies any number of transformations to the Axios response content
 * so that future fetches of the same url will generate the same hash.
 *
 * I.e. remove nonce values from the DOM (since these change with each page load)
 *
 */
export type FilterFunction = (content: string) => string;

export type FilterFunctions = Record<string, FilterFunction>;
 
export let baseFilters: FilterFunctions = {
  body: (content: string) => {
    const bodyRegex = new RegExp(/(<body[\s\S]*?<\/body.*?>)/gim);
    const bodyMatches = bodyRegex.exec(content);
    if (bodyMatches == null || bodyMatches[1] == null) {
      return content;
    }
    return bodyMatches[1];
  },
  nonce: (content)=>content.replace(/<.*(?:(?:nonce)|(?:csrfmiddlewaretoken)).*>/ig,""),
  readmeio: (content)=>{
    const r = new RegExp(/<script.*?data-initial-props="(.*?)"><\/script/,"gim")
    const result = r.exec(content)
    if (result == null || result[1]==null) {
      return content
    }
    // ReadmeIO gives us the OAS JSON blob
    const decoded = decode(result[1])
    const slug = new RegExp(/"(?:slug)?updatedAt".*?,/,"gmi")
    return decoded.replace(slug,"")
  },
  cloudflare: (content)=>{
    const r = new RegExp(/<script>.*?challenge-platform.*?<\/script>/,"gmi")
    return content.replace(r,"")
  },
  zendesk: (content)=> {
    /**
     * ZenDesk includes a version header in a comment at the top
     * of the page, and then uses it in some .js includes
     * 
     * Strip out the version number for idempotency
     */
    const vr = new RegExp(/<!-- (v\d+) -->/,"gmi")
    const result = vr.exec(content)
    if (result == null || result[1]==null) {
      return content
    }
    const replace = new RegExp(`${result[1]}`,"gmi")
    /**
     * ZenDesk seems to have a static asset CDN which uses randomish urls, presumably for cache-busting
     * 
     * Find them and remove them for idempotency
     */
    const assetsRegex = new RegExp(/<((?:script)|(?:link)).*?zdassets.com\/hc\/(?:[\w\d])*assets\/.*(?:\/script)?>/gmi)
    return content.replace(replace,"").replace(assetsRegex,"")
  },
  datadog: (content) => {
    const vr = new RegExp(/DD_RUM[\s\S]*?version: '(.*?)',/gmi)
    const result = vr.exec(content)
    if (result == null || result[1] == null){ 
      return content
    }
    const replace = new RegExp(`${result[1]}`,"gmi")
    return content.replace(replace,"")
  }
};
import axios from "axios";

export const BASE_URL = 'https://api.github.com'

// stupid cache for now
let _cache = {
  data: {},
  async get(key, defaultValue) {
    return this.data[key] === undefined ? defaultValue : JSON.parse(this.data[key]);
  },
  async set(key, value) {
    this.data[key] = JSON.stringify(value);
  }
};

export function setCache(cache) {
  _cache = cache;
}

const getHeaders = (token, headers = null) => {
  const defaults = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` };
  return { ...defaults, ...headers };
}

const errorHandler = (err) => {
  if (err?.response?.status) {
    const data = err.response?.data;
    if (data.message) {
      throw new Error(data.message);
    } else {
      throw data.toString();
    }
  }
  throw err;
}

export async function cleanRepoString({ input, token }) {
  if (input.startsWith('https://github.com/')) {
    input = input.substring(19);
  }
  let repo = input.match(/^[^\/]+\/[^\/#]+/)[0];
  input = input.substring(repo.length);
  if (input.startsWith('/')) {
    input = input.substring(1);
  }

  let repoData;

  repoData = await getRepository({ repo, token });


  let [path, branch] = input.split('#');
  if (branch) {
    let branchObj = await getBranch({ repo, branch, token })
    branch = branchObj.name;
  }

  return {
    repr: `${repoData.full_name}${path ? `/${path}` : ''}${branch ? `#${branch}` : ''}`,
    repo: repoData.full_name,
    path: path,
    branch: branch
  }
}

export async function uploadFiles({ repo, branch, token, files, message }) {
  files = await Promise.all(files.map(async (f) => {
    let resp = await axios.post(
      `${BASE_URL}/repos/${repo}/git/blobs`,
      {
        content: f.content,
        encoding: f.encoding,
      },
      {
        headers: getHeaders(token, { 'Content-Type': 'application/json' })
      });
    return {
      mode: "100644",
      type: "blob",
      sha: resp.data.sha,
      path: f.path
    };
  }));
  const branchObj = await getBranch({ repo, branch, token });
  const base_tree = branchObj.commit.commit.tree.sha;
  let resp = await axios.post(
    `${BASE_URL}/repos/${repo}/git/trees`,
    {
      base_tree,
      tree: files
    },
    { headers: getHeaders(token, { 'Content-Type': 'application/json' }) }
  );
  const tree_sha = resp.data.sha;

  resp = await axios.post(
    `${BASE_URL}/repos/${repo}/git/commits`,
    {
      message,
      tree: tree_sha,
      parents: [branchObj.commit.sha]
    },
    { headers: getHeaders(token, { 'Content-Type': 'application/json' }) }
  );
  const commit_sha = resp.data.sha;
  resp = await axios.patch(
    `${BASE_URL}/repos/${repo}/git/refs/heads/${branchObj.name}`,
    { sha: commit_sha },
    { headers: getHeaders(token, { 'Content-Type': 'application/json' }) }
  );

}

export async function uploadThumbnail({ repo, branch, path, data, token, sha }) {
  try {
    axios.put(`${BASE_URL}/repos/${repo}/contents/${path}.png`, {
      message: `Add thumbnail for ${path}`,
      content: data,
      sha,
      branch,
    }, { headers: getHeaders(token, { 'Content-Type': 'application/json' }) });
  } catch (err) {
    errorHandler(err);
  }

}

export async function getRepository({ repo, token }) {
  return (await axios.get(`${BASE_URL}/repos/${repo}`, { headers: getHeaders(token) })).data;
}

export async function downloadBlob({ url, token }) {
  let cached = await _cache.get(`blobcache:${url}`, null);
  if (cached === null) {
    const response = await axios.get(url, { headers: getHeaders(token) });
    cached = response.data;
    await _cache.set(`blobcache:${url}`, cached);
  }
  return cached;
}

export async function downloadBlobJson({ url, token }) {
  const blob = await downloadBlob({ url, token });
  let content = blob.content;
  if (blob.encoding === 'base64') {
    content = atob(content);
  }
  return JSON.parse(content);
}

export async function downloadBlobImageAsDataUri({ url, token }) {
  const blob = await downloadBlob({ url, token });
  return `data:image/png;base64,${blob.content}`;
}

export async function getBranch({ repo, branch, token }) {
  if (!branch) {
    const repoInfo = await getRepository({ repo, token });
    branch = repoInfo.default_branch;
  }
  try {
    return (await axios.get(`${BASE_URL}/repos/${repo}/branches/${branch}`, { headers: getHeaders(token) })).data;
  } catch (err) {
    errorHandler(err);
  }
}

export function fileFolderSort(a, b) {
  return ((b.type === 'tree') - (a.type === 'tree')) || a.path.localeCompare(b.path);
}

export function _getContentType(path) {
  let extension = path.match(/^.*?(\.[^\.]*)?$/)[1];
  if (!extension) return null;
  extension = extension.toLowerCase();
  if (extension == '.stp') {
    extension = '.step';
  }
  if (['.step', '.f3d', '.svg', '.dxf'].indexOf(extension) !== -1) {
    return extension.substring(1);
  } else if (extension === '.png') {
    return 'thumb';
  } else if (extension === '.json') {
    return 'meta';
  }
}

export function _mergeNodes(n1, n2) {
  return { ...n1, content_types: { ...n1.content_types, ...n2.content_types } };
}

export function _mergeTrees(t1, t2) {
  const results = [...t1];
  t2.forEach(node => {
    let match = t1.filter(n => n.name == node.name && n.type == node.type)[0];
    if (!match) {
      results.push(node);
      return;
    }
    if (match.type === 'tree') {
      match.children = _mergeTrees(match.children, node.children);
    } else {
      results.splice(results.indexOf(match), 1);
      match = _mergeNodes(match, node);

      results.push(match);
    }
  });
  return results;
}

export function pruneTree(tree) {
  const pruned = [];
  tree.forEach(n => {
    if (n.type === 'tree') {
      n.children = pruneTree(n.children);
      pruned.push(n);
    } else {
      const ct = n.content_types;
      if (ct.step || ct.f3d || ct.dxf || ct.svg) {
        pruned.push(n);
      }
    }
  })
  return pruned;
}

export function sortTree(tree) {
  tree.filter(node => node.type === 'tree').forEach(n => {
    sortTree(n.children);
  })
  tree.sort(fileFolderSort);
  return tree;
}

export function _getChildNodeByPath(tree, path) {
  if (path) {
    for (const p of path.split('/')) {
      if (Array.isArray(tree)) {
        tree = tree.filter(n => n.name === p)[0];
      } else {
        tree = tree.children.filter(n => n.name === p)[0];
      }
      if (!tree) return null;
    }
  }
  return tree;
}

export function _mergeKeywords(kw1, kw2) {
  kw1 = kw1 || [];
  kw2 = kw2 || [];

  kw1 = Array.isArray(kw1) ? kw1 : kw1.split(/\s+/);
  kw2 = Array.isArray(kw2) ? kw2 : kw2.split(/\s+/);
  const kw1Lower = kw1.map((kw) => kw.toLowerCase());

  return [...kw1, ...kw2.filter(kw => kw1Lower.indexOf(kw.toLowerCase()) === -1)].join(' ');
}

export function applyMeta(tree, dirMeta) {
  console.log("Applying DirMeta", tree, dirMeta);
  // modifies objects in place
  for (const [path, meta] of Object.entries(dirMeta)) {
    const node = _getChildNodeByPath(tree, path);
    node.meta = {
      ...node?.meta || {}, ...meta || {}, keywords: _mergeKeywords(node?.meta?.keywords, meta?.keywords)
    }
  }
}

export function buildMetaCache(tree, meta, prefix) {
  meta = meta || {};
  prefix = prefix || '';
  for (const node of tree) {
    if (node.type === 'tree') {
      buildMetaCache(node.children, meta, prefix + `${node.name}/`);
    } else if (node.type === 'blob' && node.meta && Object.keys(node.meta).length) {
      meta[`${prefix}${node.name}`] = node.meta;
    }
  }
  return meta;
}

export async function indexTree({ tree, token, treeShas, hasCache }) {
  let cachedMeta;

  // treeShas is only passed in on the root
  if (treeShas) {
    cachedMeta = await _cache.get(`metacache:${treeShas.join(":")}`, null)
    hasCache = cachedMeta !== null;
  }

  let results = [];
  for (let n of tree) {
    if (n.type === 'tree') {
      results.push({ ...n, children: await indexTree({ tree: n.children, token, hasCache }) })
      continue;
    }
    if (n.content_types.meta) {
      let meta = {};
      if (!hasCache) {
        meta = await downloadBlobJson({ url: n.content_types.meta.url, token });
      }
      results.push({ ...n, meta });
      continue;
    }
    results.push({ ...n });
  }

  const metaFile = results.filter(n => n.name == '_meta' && n?.content_types?.meta)[0];
  if (metaFile) {
    if (!hasCache) {
      console.log("Downloading meta", metaFile.content_types.meta.url);
      const dirMeta = await downloadBlobJson({ url: metaFile.content_types.meta.url, token });
      console.log("got", dirMeta);
      applyMeta(results, dirMeta);
    }
    results = results.filter(n => n.id !== metaFile.id);
  }

  if (treeShas) {
    if (hasCache) {
      applyMeta(results, cachedMeta);
    } else {
      cachedMeta = buildMetaCache(results);
      await _cache.set(`metacache:${treeShas.join(":")}`, cachedMeta);
    }
  }
  return results;
}

export function _buildTree(tree, root, id_prefix = '') {
  const results = [];
  while (tree.length > 0) {
    let node = tree[0];
    if (!node.path.startsWith(root)) {
      break;
    }
    tree.shift();
    node.id = `${id_prefix}|${node.path}`;
    node.name = node.path.split('/').pop();
    node.name = node.name.match(/^(.*?)(\.[^\.]*)?$/)[1];
    delete node.sha;
    delete node.mode;
    if (node.type == 'tree') {
      node.children = _buildTree(tree, `${node.path}/`, id_prefix);
      if (node.children.length === 0) {
        continue;
      }
    } else if (node.type == 'blob') {
      let contentType = _getContentType(node.path);
      if (!contentType) {
        continue;
      }
      node.content_types = { [contentType]: { url: node.url, size: node.size, path: node.path } };
      node.path = node.path.match(/^(.*?)(\.[^\.]*)?$/)[1];
      delete node.url;
      delete node.size;
      if (results.length > 0) {
        const prev = results[results.length - 1];
        if (prev.type === 'blob' && prev.path === node.path) {
          results.pop();
          node = _mergeNodes(prev, node);
        }
      }
    }
    results.push(node);
  }

  return results;
}

export async function getRepoTree({ repo, branch, token, id_prefix }) {
  branch = await getBranch({ repo, branch, token });
  let cachedTree = await _cache.get(`tree:${repo}:${branch.name}`);
  if (!cachedTree || cachedTree.sha !== branch.commit.commit.tree.sha) {
    // outdated or missing cache
    try {
      cachedTree = (await axios.get(`${BASE_URL}/repos/${repo}/git/trees/${branch.commit.commit.tree.sha}?recursive=1`, { headers: getHeaders(token) })).data;
    } catch (err) {
      errorHandler(err);
    }

    await _cache.set(`tree:${repo}:${branch.name}`, cachedTree);
  }
  return [_buildTree(cachedTree.tree, '', id_prefix), branch.commit.commit.tree.sha];
}

export function getSubtree(tree, root) {
  root = root.replace(/^\//, '').replace('\//$', '');
  root.split('/').forEach(p => {
    tree = tree.filter(c => c.name === p && c.type == 'tree')[0]?.children;
    if (tree === undefined) {
      throw Error("Invalid repository path");
    }
  });
  return tree;
}

export async function getMergedTrees({ repositories, token, id_prefix, index, setLoadingMessage }) {
  let tree = [];
  let treeShas = [];

  for (let repo of repositories) {
    setLoadingMessage(`Loading ${repo}...`);
    const match = repo.match(/^([\w-]+)\/([\w-]+)((?:\/[\w-]+)*)(#.*)?$/);
    if (match != null) {
      let [_, owner, name, path, branch] = match;
      if (branch) {
        branch = branch.substring(1);
      } else {
        const r = await getRepository({ repo: `${owner}/${name}`, token });
        branch = r.default_branch;
      }
      setLoadingMessage(`Loading ${repo}#${branch}...`);
      let [newTree, newTreeSha] = await getRepoTree({ repo: `${owner}/${name}`, branch, token, id_prefix });
      treeShas.push(newTreeSha);
      if (path) {
        newTree = getSubtree(newTree, path);
      }
      tree = _mergeTrees(tree, newTree);
    }
  }
  if (index) {
    setLoadingMessage("Indexing tree...");
    tree = await indexTree({ tree, token, treeShas });
  }
  return sortTree(pruneTree(tree))
}
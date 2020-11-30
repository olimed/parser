const fs = require("fs");
const path = require("path");
const postcss = require("postcss");
const syntax = require("postcss-less");
// const less = require('postcss-less-engine');

/**
 * Function devides str into an ordered list of substrings
 *
 * @param {String} str
 *
 * @return {Array<String>}
 */
function parseParams(str) {
  if (str.includes("(")) {
    const allParams = str.split("(").reduce((allArgs, args) => {
      allArgs = [
        ...allArgs,
        ...args.split(",").filter((val) => !val.trim().indexOf("@")),
      ];
      return allArgs;
    }, []);
    return allParams.map((p) => p.trim().split(")")[0]);
  }
  let params = str.split(' ');
  if (str.includes(',')) {
    params = str.split(",");
  } 
  params = params.map((p) => p.trim());
  return params.filter((p) => p.includes("@"));
}

function getNameSelector(str) {
  const name = str.replace(/(\r\n|\n|\r)/gm, "");
  if (name.includes("(")) {
    return [name.split("(")[0]];
  }
  return name.split(",");
}

/**
 * Get full selectors
 *
 * @param {Array<String>|String} selector
 * @param {postcss.Node} decl
 *
 * @return {Array<String>}
 */
function parseSelector(selector, decl) {
  if (decl.type == "root") return selector;
  const selectors = Array.isArray(selector)
    ? [...selector]
    : getNameSelector(selector);
  const parentSelectors = decl.parent.selector
    ? decl.parent.selector.replace(/(\r\n|\n|\r)/gm, "").split(",")
    : [""];
  let mapSelectors = [];
  selectors.forEach((selectr) => {
    parentSelectors.forEach((parentSelector) => {
      const fullSelector = selectr.trim().split("&")[1]
        ? `${parentSelector}${selectr.trim().split("&")[1]}`
        : `${parentSelector ? parentSelector : ""} ${selectr.trim()}`.trim();
      mapSelectors.push(fullSelector);
    });
  });

  if (decl.type === "atrule" && decl.name === "media") {
    const mediaParam = `[@${decl.name} ${decl.params}]`;
    mapSelectors = mapSelectors.map(sel => `${mediaParam} ${sel}`)
  }
  return parseSelector(mapSelectors, decl.parent);
}

function findAllSelectorsByVar(allVars, nameVar, selectors = {}) {
  if (!allVars[nameVar]) {
    return selectors;
  }
  if (allVars[nameVar].value) {
    if (!allVars[nameVar].value.includes("@")) {
      allVars[nameVar].selectors = {
        ...allVars[nameVar].selectors,
        ...selectors,
      };
      return allVars[nameVar].selectors;
    }
    const names = parseParams(allVars[nameVar].value);
    selectors = {
      ...selectors,
      ...allVars[nameVar].selectors,
    };
    names.forEach((name) => {
      const selector = findAllSelectorsByVar(allVars, name, selectors);
      selectors = { ...selectors, ...selector };
    });
  }
  return selectors;
}

function parseVariables(allVars) {
  Object.keys(allVars).forEach((key) => {
    if (allVars[key].value && allVars[key].value.includes("@")) {
      const selectors = findAllSelectorsByVar(allVars, key);
      allVars[key].selectors = {
        ...allVars[key].selectors,
        ...selectors,
      };
    }
  });
}

/**
 * Get all selectors and value for variables
 *
 * @param {postcss.Root} root
 *
 * @return {{selectors: Object<String, Array<String>, value: String}}
 */
function walkDecls(root) {
  const output = {};
  const { vars } = getVarsAndMixins(root);
  root.walkDecls((decl) => {
    const ind = decl.value.toString().indexOf("@");
    if (ind != -1) {
      const selectors = parseSelector(
        decl.parent.selector.toString
          ? decl.parent.selector.toString()
          : decl.parent.selector.split('"')[1],
        decl.parent
      );
      const varName = parseParams(decl.value); // ind == 0 ? [decl.value] : 
      varName.forEach((v) => {
        selectors.forEach((selector) => {
          output[v] = {
            [selector.toString()]: [],
            ...output[v],
          };
          output[v][selector.toString()].push(decl.prop);
        });
      });
    }
  });
  const variables = vars.reduce((prev, v) => {
    prev[v.name] = {
      value: v.value
    }
    return prev;
  }, {})
  const map = Object.keys(output).reduce((prev, key) => {
    prev[key] = {
      selectors: output[key] || {},
      value: variables[key] ? variables[key].value : "",
    };
    return prev;
  }, {});
  return map;
}

/**
 * Get all mixins (that are called) and variables
 *
 * @param {postcss.Root} root
 *
 * @return {{atRuleMixins: Array<postcss.AtRule>, vars: Array<{name: String, value: String}>}}
 */
function getVarsAndMixins(root) {
  const result = { vars: [] };
  root.walkAtRules((atrule) => {
    if (atrule.name != "import" && atrule.name != "media") {
      // todo
      result.vars.push({
        name: `@${atrule.name.toString().split(":")[0]}`,
        value: atrule.params,
      });
    }
  });
  return result;
}

function checkRule(rule) {
  let isCheck = true;
  rule.walkAtRules((atrule) => {
    if (atrule) {
      isCheck = false;
    }
  });
  rule.walkRules((r) => {
    if (r) {
      isCheck = false;
    }
  });
  return isCheck;
}

function getAllMixins(root) {
  try {
    const mapMixins = {};
    function parseRule(node, parentSelector) {
      if (!node.nodes || node.nodes.length) {
        if (node.type === "decl") {
          return node;
        }
        if (node.mixin) {
          const mixinName = `${node.raws.identifier}${node.name}`;
          if (!mapMixins[mixinName]) {
            console.log(`Please define class/mixin ${mixinName} before ${parentSelector || ""}`)
            throw `Please define mixin ${mixinName} before ${parentSelector || ""}`
          }
          mapMixins[mixinName].nodes.forEach((child) => {
            node.before(child.clone());
          });
          node.remove();
          return { mixin: true };
        }
      }
      node.each((child) => {
        if (child.type === "rule" && !mapMixins[child.selector.split("(")[0]]) {
          const names =
            child.selector[0] === "&"
              ? parseSelector(child.selector.split("(")[0], child)
              : [child.selector.split("(")[0].trim()];
          const rule = parseRule(child, node.selector);

          names.forEach((name) => {
            mapMixins[name] = rule;
          });
        } else {
          const newChild = parseRule(child, node.selector);
          if (!newChild.mixin) {
            child.replaceWith(newChild);
          }
        }
      });
      return node;
    }

    root.walkRules((node) => {
      if (node.type === "rule") {
        let newRule = node;
        if (!checkRule(node)) {
          newRule = parseRule(node);
        }
        const mixinName =
          newRule.selector[0] === "&"
            ? parseSelector(newRule.selector.split("(")[0], node)
            : [newRule.selector.split("(")[0].trim()];
        mixinName.forEach((name) => {
          mapMixins[name] = newRule;
        });
      }
    });
    return mapMixins;
  } catch (error) {
    throw error;
  }
}

function getCleanTree(ast) {
  const newAst = { ...ast };
  newAst.root.walkComments((comment) => {
    comment.remove();
  });
  return newAst;
}

async function getAllFilesName(root, mainPath) {
  const pathFiles = [];
  const mainDir = path.dirname(mainPath);
  root.walkAtRules((rule) => {
    if (rule.name === "import") {
      pathFiles.push(path.join(mainDir, rule.params.split('"')[1]));
    }
  });
  let allPathes = [...pathFiles];
  await Promise.all(
    pathFiles.map(async (p, ind) => {
      const ps = await getInnerImports(p, root, ind, allPathes);
      allPathes.splice(ind, 0, ...ps);
    })
  );
  // allPathes = [...allPathes.reverse(), mainPath];
  allPathes = [...allPathes, mainPath];
  return [...new Set(allPathes)]; //allPathes.uni;
}

async function getInnerImports(mainPath, mainRoot, ind, pathes = []) {
  try {
    let pathFiles = [];
    const mainDir = path.dirname(mainPath);
    const data = await fs.promises.readFile(mainPath);
    const res = await postcss().process(data, {
      syntax,
      from: mainPath,
    });
    if (!res) {
      throw `Something went wrong while building AST from ${mainPath}`;
    }
    const root = res.root;
    root.walkAtRules((rule) => {
      if (rule.name === "import") {
        const newPath = path.join(mainDir, rule.params.split('"')[1]);
        if (!pathes.includes(newPath)) pathFiles.push(newPath);
      }
    });
    if (!pathFiles.length) return pathFiles;
    let allPathes = [...pathFiles];
    const indexPathes = [...pathes];
    indexPathes.splice(ind, 0, ...pathFiles);
    await Promise.all(
      pathFiles.map(async (p, i) => {
        const ps = await getInnerImports(p, mainRoot, i, [
          // ...pathes,
          // ...pathFiles,
          ...indexPathes
        ]);
        // allPathes = [...allPathes, ...ps];
        allPathes.splice(i, 0, ...ps);
      })
    );
    return allPathes;
  } catch (error) {
    throw error;
  }
}

async function importAllFiles(pathes) {
  try {
    const mainPath = path.join(__dirname, "./dist/main.less");
    if (!fs.existsSync(path.join(__dirname, "./dist"))) {
      fs.mkdirSync(path.join(__dirname, "./dist"));
    }
    const fd = fs.openSync(mainPath, "w+");
    pathes.forEach((p) => {
      const newLess = fs.readFileSync(p, "utf8");
      if (newLess) {
        fs.appendFileSync(mainPath, Buffer.from(`${newLess}\n`));
      }
    });
    fs.closeSync(fd);
    const lessData = fs.readFileSync(
      path.join(__dirname, "dist/main.less"),
      "utf8"
    );
    const res = await postcss().process(lessData, {
      syntax,
      from: mainPath,
    });
    return res;
  } catch (error) {
    throw error;
  }
}

function writeToFile(text) {
  try {
    const mainPath = "./dist/result.json";
    if (!fs.existsSync("./dist")) {
      fs.mkdirSync("./dist");
    }
    const fd = fs.openSync(mainPath, "w+");
    fs.writeFileSync(mainPath, Buffer.from(JSON.stringify(text)));
    fs.closeSync(fd);
  } catch (error) {
    console.log(error);
    throw error;
  }
}

function filterVariables(allVars, vars) {
  return vars.reduce((prevValue, currentValue) => {
    prevValue[currentValue] = allVars[currentValue] || {};
    return prevValue;
  }, {});
}

async function start() {
  try {
    const [varPath, mainPath] = await getCorrectParams();
    let vars = fs.readFileSync(varPath, "utf8");
    vars = JSON.parse(vars);
    const mainLess = fs.readFileSync(mainPath, "utf8");
    const mainRoot = await postcss().process(mainLess, {
      syntax,
      from: mainPath,
    });
    // const allImports = await getAllFilesName(mainRoot.root, mainPath);
    // writeToFile(allImports);
    // const newRoot = await importAllFiles(allImports);


    const newRoot = await importAllFiles([mainPath]);

    const ast = getCleanTree(newRoot);
    
    const mapMixins = getAllMixins(ast.root);
    const allDecl = walkDecls(ast.root);
    parseVariables(allDecl);
    writeToFile(allDecl);



    // const filteredVars = filterVariables(allDecl, vars);
    // // console.log(allDecl);
    // writeToFile(filteredVars);
  } catch (error) {
    console.log(error);
    throw error;
  }
}

async function getCorrectParams() {
  try {
    const dir = path.dirname(process.argv[1]);
    let varPath = process.argv[2];
    let lessPath = process.argv[3];
    let isExist = await fs.promises.stat(varPath);
    if (!isExist) {
      varPath = path.join(dir, varPath);
    }
    isExist = await fs.promises.stat(lessPath);
    if (!isExist) {
      lessPath = path.join(dir, lessPath);
    }
    return [varPath, lessPath];
  } catch (error) {
    console.log(`No such file or directory ${error.path}`);
    throw error;
  }
}

start();


// console.log(process.env.NODE_ENV = 'production')
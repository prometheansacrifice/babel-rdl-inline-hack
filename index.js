'use strict';

const fs = require('fs');
const traverse = require('babel-traverse');
const generate = require('babel-generator');
const t = require('babel-types');

const { SourceMapConsumer } = require('source-map');

const {
  parse,
  readSource,
  resolveFileName,
  bundle,
  getDir,
  write,
  join,
  searchCode
} = require('./utils');

let hostConfigDeclarations = [];

module.exports = function inlineHostConfigDeclarations(ast, srcReconcilerJSPath, sourceMapPathFullyResolved) {
  const sourceMapJSON = JSON.parse(
    fs.readFileSync(sourceMapPathFullyResolved).toString()
  );

  const consumerPromise = new SourceMapConsumer(sourceMapJSON);

  const REACT_RECONCILER_CALL_CODE =
    'Reconciler(__DEV__ ? HostConfigDev : HostConfigProd)';

  // get position in source
  const RECONCILER_JS_SOURCE = readSource(
    srcReconcilerJSPath
  );

  const { line, code, pos } = searchCode(
    RECONCILER_JS_SOURCE,
    REACT_RECONCILER_CALL_CODE
  );

  // const hostConfigObjectExpression = getHostConfigObjectExpression()
  consumerPromise.then(consumer => {
    const {
      line: targetLine,
      column: targetColumn
    } = consumer.generatedPositionFor({
      source: '../src/Reconciler.js',
      line: line + 1,
      column: pos
    });

    const targetSource = MAIN_FILE_CONTENTS.split('\n')[targetLine - 1].slice(
      targetColumn
    );
    // Basically `reactReconciler(HostConfigDev$1);` in the bundled file
    // But we never know what rollup renames the variables to. Thats why
    // the sourcemap lookup

    // Get reconciler callee name and host config object identifier
    const reconcilerCallAST = parse(targetSource);
    let calleeName, hostConfigIdentifier;

    traverse.default(reconcilerCallAST, {
      CallExpression(path) {
        const { callee, arguments: args } = path.node;
        calleeName = callee.name;
        hostConfigIdentifier = args[0].name;
      }
    });

    // I should probably avoid multiple traversals. But for now I'm going to do it anyway


    traverse.default(ast, {
      CallExpression(path) {
        const { callee, arguments: args } = path.node;
        if (callee.name === calleeName) {
          path.node.arguments = [
            t.objectExpression([])
          ];
        }
      }
    });



    let hostConfigProps;
    traverse.default(ast, {
      VariableDeclaration(path) {
        const {
          node: { declarations }
        } = path;
        let isHostConfigDeclaration = false;
        declarations.forEach(declarator => {
          if (declarator.id.name === hostConfigIdentifier) {
            isHostConfigDeclaration = true;
            hostConfigProps = declarator.init.arguments[0].properties.map(
              p => p.value.name
            );
          }
        });
        if (isHostConfigDeclaration) {
          path.remove();
        }
      }
    });

    // Search for all declarations for all of hostConfigProps
    let hostConfigDeclarations = [];
    traverse.default(ast, {
      VariableDeclaration(path) {
        const {
          node: { declarations }
        } = path;
        declarations.forEach(declarator => {
          // All global host config props
          if (
            !declarator.init ||
            declarator.init.type !== 'MemberExpression' ||
            !declarator.init.object ||
            declarator.init.object.name !== '$$$hostConfig'
          ) {
            if (hostConfigProps.indexOf(declarator.id.name) !== -1) {
              hostConfigDeclarations.push(declarator);
            }
          }
        });
      },
      FunctionDeclaration(path) {
        const { node } = path;
        if (hostConfigProps.indexOf(node.id.name) !== -1) {
          hostConfigDeclarations.push(node);
        }
      }
    });

    // Inline the declarations in reconciler($$$hostConfig)
    traverse.default(ast, {
      FunctionExpression(path) {
        const { node } = path;
        if (node.id && node.id.name === '$$$reconciler') {
          path.traverse({
            VariableDeclaration(vPath) {
              const {
                node: { declarations }
              } = vPath;

              const declarationVarNames = declarations.map(d => d.id.name);
              let hostConfigVarDeclarators = hostConfigDeclarations.filter(
                d =>
                  d.type === 'VariableDeclarator' &&
                  declarationVarNames.indexOf(d.id.name) !== -1
              );
              let hostConfigFunctionDeclarations = hostConfigDeclarations.filter(
                d =>
                  d.type === 'FunctionDeclaration' &&
                  declarationVarNames.indexOf(d.id.name) !== -1
              );

              let nonHostConfigDeclarators = declarations.filter(
                declarator => hostConfigProps.indexOf(declarator.id.name) === -1
              );

              const inlinedHostConfigDeclarators = hostConfigVarDeclarators.concat(
                nonHostConfigDeclarators
              );
              if (inlinedHostConfigDeclarators.length) {
                vPath.node.declarations = inlinedHostConfigDeclarators;
              } else {
                vPath.replaceWithMultiple(hostConfigFunctionDeclarations)
              }
            }
          });
        }
      }
    });

    return generate.default(ast).code;
  });
}

// const MAIN_FILE_CONTENTS = readSource(
//   join(
//     __dirname,
//     'react-dom-lite.js'
//   )
// );

// if (!process.env.SRC_RECONCILER_PATH) {
//   console.log('No SRC_RECONCILER_PATH in env')
// }

// const result = inlineHostConfigDeclarations(
//   parse(MAIN_FILE_CONTENTS)
//   process.env.SRC_RECONCILER_PATH,
//   join(
//     __dirname,
//     'react-dom-lite.js.map'
//   )
// );

// write('tmp.js', result);

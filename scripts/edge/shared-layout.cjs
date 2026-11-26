'use strict';

const functionsPath = 'supabase/functions';
const sharedName = '_shared';
const isFunctionDirectory = name => name && name !== sharedName && !name.startsWith('.');

function edgeSharedSource(filename) {
  if (!filename.startsWith(functionsPath + '/')) return undefined;
  const [name, copy, ...relative] = filename.slice(functionsPath.length + 1).split('/');
  if (isFunctionDirectory(name) && copy === sharedName && relative.length) {
    return [functionsPath, sharedName, ...relative].join('/');
  }
}

module.exports = { functionsPath, sharedName, isFunctionDirectory, edgeSharedSource };

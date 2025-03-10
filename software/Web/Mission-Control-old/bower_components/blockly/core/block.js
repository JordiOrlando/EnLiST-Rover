/**
 * @license
 * Visual Blocks Editor
 *
 * Copyright 2011 Google Inc.
 * https://developers.google.com/blockly/
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview The class representing one block.
 * @author fraser@google.com (Neil Fraser)
 */
'use strict';

goog.provide('Blockly.Block');

goog.require('Blockly.Blocks');
goog.require('Blockly.Comment');
goog.require('Blockly.Connection');
goog.require('Blockly.Input');
goog.require('Blockly.Mutator');
goog.require('Blockly.Warning');
goog.require('Blockly.Workspace');
goog.require('Blockly.Xml');
goog.require('goog.array');
goog.require('goog.asserts');
goog.require('goog.math.Coordinate');
goog.require('goog.string');


/**
* Class for one block.
* @constructor
*/
Blockly.Block = function() {
  // We assert this here because there may be users of the previous form of
  // this constructor, which took arguments.
  goog.asserts.assert(arguments.length == 0,
      'Please use Blockly.Block.obtain.');
};

/**
 * Obtain a newly created block.
 * @param {!Blockly.Workspace} workspace The block's workspace.
 * @param {?string} prototypeName Name of the language object containing
 *     type-specific functions for this block.
 * @return {!Blockly.Block} The created block
 */
Blockly.Block.obtain = function(workspace, prototypeName) {
  if (Blockly.Realtime.isEnabled()) {
    return Blockly.Realtime.obtainBlock(workspace, prototypeName);
  } else {
    if (workspace.rendered) {
      var newBlock = new Blockly.BlockSvg();
    } else {
      var newBlock = new Blockly.Block();
    }
    newBlock.initialize(workspace, prototypeName);
    return newBlock;
  }
};

/**
 * Initialization for one block.
 * @param {!Blockly.Workspace} workspace The new block's workspace.
 * @param {?string} prototypeName Name of the language object containing
 *     type-specific functions for this block.
 */
Blockly.Block.prototype.initialize = function(workspace, prototypeName) {
  this.id = Blockly.Blocks.genUid();
  workspace.addTopBlock(this);
  this.fill(workspace, prototypeName);
};

/**
 * Fill a block with initial values.
 * @param {!Blockly.Workspace} workspace The workspace to use.
 * @param {string} prototypeName The typename of the block.
 */
Blockly.Block.prototype.fill = function(workspace, prototypeName) {
  this.outputConnection = null;
  this.nextConnection = null;
  this.previousConnection = null;
  this.inputList = [];
  this.inputsInline = false;
  this.rendered = false;
  this.disabled = false;
  this.tooltip = '';
  this.contextMenu = true;

  this.parentBlock_ = null;
  this.childBlocks_ = [];
  this.deletable_ = true;
  this.movable_ = true;
  this.editable_ = true;
  this.collapsed_ = false;

  this.comment = null;

  this.xy_ = new goog.math.Coordinate(0, 0);

  this.workspace = workspace;
  this.isInFlyout = workspace.isFlyout;

  // Copy the type-specific functions and data from the prototype.
  if (prototypeName) {
    this.type = prototypeName;
    var prototype = Blockly.Blocks[prototypeName];
    goog.asserts.assertObject(prototype,
        'Error: "%s" is an unknown language block.', prototypeName);
    goog.mixin(this, prototype);
  }
  // Call an initialization function, if it exists.
  if (goog.isFunction(this.init)) {
    this.init();
  }
};

/**
 * Get an existing block.
 * @param {string} id The block's id.
 * @param {!Blockly.Workspace} workspace The block's workspace.
 * @return {Blockly.Block} The found block, or null if not found.
 */
Blockly.Block.getById = function(id, workspace) {
  if (Blockly.Realtime.isEnabled()) {
    return Blockly.Realtime.getBlockById(id);
  } else {
    return workspace.getBlockById(id);
  }
};

/**
 * Dispose of this block.
 * @param {boolean} healStack If true, then try to heal any gap by connecting
 *     the next statement with the previous statement.  Otherwise, dispose of
 *     all children of this block.
 * @param {boolean} animate If true, show a disposal animation and sound.
 * @param {boolean} opt_dontRemoveFromWorkspace If true, don't remove this
 *     block from the workspace's list of top blocks.
 */
Blockly.Block.prototype.dispose = function(healStack, animate,
                                           opt_dontRemoveFromWorkspace) {
  this.unplug(healStack, false);

  // This block is now at the top of the workspace.
  // Remove this block from the workspace's list of top-most blocks.
  if (this.workspace && !opt_dontRemoveFromWorkspace) {
    this.workspace.removeTopBlock(this);
    this.workspace = null;
  }

  // Just deleting this block from the DOM would result in a memory leak as
  // well as corruption of the connection database.  Therefore we must
  // methodically step through the blocks and carefully disassemble them.

  if (Blockly.selected == this) {
    Blockly.selected = null;
  }

  // First, dispose of all my children.
  for (var i = this.childBlocks_.length - 1; i >= 0; i--) {
    this.childBlocks_[i].dispose(false);
  }
  // Then dispose of myself.
  // Dispose of all inputs and their fields.
  for (var i = 0, input; input = this.inputList[i]; i++) {
    input.dispose();
  }
  this.inputList.length = 0;
  // Dispose of any remaining connections (next/previous/output).
  var connections = this.getConnections_(true);
  for (var i = 0; i < connections.length; i++) {
    var connection = connections[i];
    if (connection.targetConnection) {
      connection.disconnect();
    }
    connections[i].dispose();
  }
  // Remove from Realtime set of blocks.
  if (Blockly.Realtime.isEnabled() && !Blockly.Realtime.withinSync) {
    Blockly.Realtime.removeBlock(this);
  }
};

/**
 * Unplug this block from its superior block.  If this block is a statement,
 * optionally reconnect the block underneath with the block on top.
 * @param {boolean} healStack Disconnect child statement and reconnect stack.
 * @param {boolean} bump Move the unplugged block sideways a short distance.
 */
Blockly.Block.prototype.unplug = function(healStack, bump) {
  bump = bump && !!this.getParent();
  if (this.outputConnection) {
    if (this.outputConnection.targetConnection) {
      // Disconnect from any superior block.
      this.setParent(null);
    }
  } else {
    var previousTarget = null;
    if (this.previousConnection && this.previousConnection.targetConnection) {
      // Remember the connection that any next statements need to connect to.
      previousTarget = this.previousConnection.targetConnection;
      // Detach this block from the parent's tree.
      this.setParent(null);
    }
    var nextBlock = this.getNextBlock();
    if (healStack && nextBlock) {
      // Disconnect the next statement.
      var nextTarget = this.nextConnection.targetConnection;
      nextBlock.setParent(null);
      if (previousTarget && previousTarget.checkType_(nextTarget)) {
        // Attach the next statement to the previous statement.
        previousTarget.connect(nextTarget);
      }
    }
  }
  if (bump) {
    // Bump the block sideways.
    var dx = Blockly.SNAP_RADIUS * (Blockly.RTL ? -1 : 1);
    var dy = Blockly.SNAP_RADIUS * 2;
    this.moveBy(dx, dy);
  }
};

/**
 * Duplicate this block and its children.
 * @return {!Blockly.Block} The duplicate.
 * @private
 */
Blockly.Block.prototype.duplicate_ = function() {
  // Create a duplicate via XML.
  var xmlBlock = Blockly.Xml.blockToDom_(this);
  Blockly.Xml.deleteNext(xmlBlock);
  var newBlock = Blockly.Xml.domToBlock(
      /** @type {!Blockly.Workspace} */ (this.workspace), xmlBlock);
  // Move the duplicate next to the old block.
  var xy = this.getRelativeToSurfaceXY();
  if (Blockly.RTL) {
    xy.x -= Blockly.SNAP_RADIUS;
  } else {
    xy.x += Blockly.SNAP_RADIUS;
  }
  xy.y += Blockly.SNAP_RADIUS * 2;
  newBlock.moveBy(xy.x, xy.y);
  newBlock.select();
  return newBlock;
};

/**
 * Returns all connections originating from this block.
 * @param {boolean} all If true, return all connections even hidden ones.
 *     Otherwise return those that are visible.
 * @return {!Array.<!Blockly.Connection>} Array of connections.
 * @private
 */
Blockly.Block.prototype.getConnections_ = function(all) {
  var myConnections = [];
  if (all || this.rendered) {
    if (this.outputConnection) {
      myConnections.push(this.outputConnection);
    }
    if (this.previousConnection) {
      myConnections.push(this.previousConnection);
    }
    if (this.nextConnection) {
      myConnections.push(this.nextConnection);
    }
    if (all || !this.collapsed_) {
      for (var i = 0, input; input = this.inputList[i]; i++) {
        if (input.connection) {
          myConnections.push(input.connection);
        }
      }
    }
  }
  return myConnections;
};

/**
 * Bump unconnected blocks out of alignment.  Two blocks which aren't actually
 * connected should not coincidentally line up on screen.
 * @private
 */
Blockly.Block.prototype.bumpNeighbours_ = function() {
  if (!this.workspace) {
    return;  // Deleted block.
  }
  if (Blockly.dragMode_ != 0) {
    return;  // Don't bump blocks during a drag.
  }
  var rootBlock = this.getRootBlock();
  if (rootBlock.isInFlyout) {
    return;  // Don't move blocks around in a flyout.
  }
  // Loop though every connection on this block.
  var myConnections = this.getConnections_(false);
  for (var i = 0, connection; connection = myConnections[i]; i++) {
    // Spider down from this block bumping all sub-blocks.
    if (connection.targetConnection && connection.isSuperior()) {
      connection.targetBlock().bumpNeighbours_();
    }

    var neighbours = connection.neighbours_(Blockly.SNAP_RADIUS);
    for (var j = 0, otherConnection; otherConnection = neighbours[j]; j++) {
      // If both connections are connected, that's probably fine.  But if
      // either one of them is unconnected, then there could be confusion.
      if (!connection.targetConnection || !otherConnection.targetConnection) {
        // Only bump blocks if they are from different tree structures.
        if (otherConnection.sourceBlock_.getRootBlock() != rootBlock) {
          // Always bump the inferior block.
          if (connection.isSuperior()) {
            otherConnection.bumpAwayFrom_(connection);
          } else {
            connection.bumpAwayFrom_(otherConnection);
          }
        }
      }
    }
  }
};

/**
 * Return the parent block or null if this block is at the top level.
 * @return {Blockly.Block} The block that holds the current block.
 */
Blockly.Block.prototype.getParent = function() {
  // Look at the DOM to see if we are nested in another block.
  return this.parentBlock_;
};

/**
 * Return the parent block that surrounds the current block, or null if this
 * block has no surrounding block.  A parent block might just be the previous
 * statement, whereas the surrounding block is an if statement, while loop, etc.
 * @return {Blockly.Block} The block that surrounds the current block.
 */
Blockly.Block.prototype.getSurroundParent = function() {
  var block = this;
  while (true) {
    do {
      var prevBlock = block;
      block = block.getParent();
      if (!block) {
        // Ran off the top.
        return null;
      }
    } while (block.getNextBlock() == prevBlock);
    // This block is an enclosing parent, not just a statement in a stack.
    return block;
  }
};

/**
 * Return the next statement block directly connected to this block.
 * @return {Blockly.Block} The next statement block or null.
 */
Blockly.Block.prototype.getNextBlock = function() {
  return this.nextConnection && this.nextConnection.targetBlock();
};

/**
 * Return the top-most block in this block's tree.
 * This will return itself if this block is at the top level.
 * @return {!Blockly.Block} The root block.
 */
Blockly.Block.prototype.getRootBlock = function() {
  var rootBlock;
  var block = this;
  do {
    rootBlock = block;
    block = rootBlock.parentBlock_;
  } while (block);
  return rootBlock;
};

/**
 * Find all the blocks that are directly nested inside this one.
 * Includes value and block inputs, as well as any following statement.
 * Excludes any connection on an output tab or any preceding statement.
 * @return {!Array.<!Blockly.Block>} Array of blocks.
 */
Blockly.Block.prototype.getChildren = function() {
  return this.childBlocks_;
};

/**
 * Set parent of this block to be a new block or null.
 * @param {Blockly.Block} newParent New parent block.
 */
Blockly.Block.prototype.setParent = function(newParent) {
  if (this.parentBlock_) {
    // Remove this block from the old parent's child list.
    var children = this.parentBlock_.childBlocks_;
    for (var child, x = 0; child = children[x]; x++) {
      if (child == this) {
        children.splice(x, 1);
        break;
      }
    }

    // Disconnect from superior blocks.
    this.parentBlock_ = null;
    if (this.previousConnection && this.previousConnection.targetConnection) {
      this.previousConnection.disconnect();
    }
    if (this.outputConnection && this.outputConnection.targetConnection) {
      this.outputConnection.disconnect();
    }
    // This block hasn't actually moved on-screen, so there's no need to update
    // its connection locations.
  } else {
    // Remove this block from the workspace's list of top-most blocks.
    // Note that during realtime sync we sometimes create child blocks that are
    // not top level so we check first before removing.
    if (goog.array.contains(this.workspace.getTopBlocks(false), this)) {
      this.workspace.removeTopBlock(this);
    }
  }

  this.parentBlock_ = newParent;
  if (newParent) {
    // Add this block to the new parent's child list.
    newParent.childBlocks_.push(this);
  } else {
    this.workspace.addTopBlock(this);
  }
};

/**
 * Find all the blocks that are directly or indirectly nested inside this one.
 * Includes this block in the list.
 * Includes value and block inputs, as well as any following statements.
 * Excludes any connection on an output tab or any preceding statements.
 * @return {!Array.<!Blockly.Block>} Flattened array of blocks.
 */
Blockly.Block.prototype.getDescendants = function() {
  var blocks = [this];
  for (var child, x = 0; child = this.childBlocks_[x]; x++) {
    blocks.push.apply(blocks, child.getDescendants());
  }
  return blocks;
};

/**
 * Get whether this block is deletable or not.
 * @return {boolean} True if deletable.
 */
Blockly.Block.prototype.isDeletable = function() {
  return this.deletable_ && !Blockly.readOnly;
};

/**
 * Set whether this block is deletable or not.
 * @param {boolean} deletable True if deletable.
 */
Blockly.Block.prototype.setDeletable = function(deletable) {
  this.deletable_ = deletable;
  this.svg_ && this.svg_.updateMovable();
};

/**
 * Get whether this block is movable or not.
 * @return {boolean} True if movable.
 */
Blockly.Block.prototype.isMovable = function() {
  return this.movable_ && !Blockly.readOnly;
};

/**
 * Set whether this block is movable or not.
 * @param {boolean} movable True if movable.
 */
Blockly.Block.prototype.setMovable = function(movable) {
  this.movable_ = movable;
};

/**
 * Get whether this block is editable or not.
 * @return {boolean} True if editable.
 */
Blockly.Block.prototype.isEditable = function() {
  return this.editable_ && !Blockly.readOnly;
};

/**
 * Set whether this block is editable or not.
 * @param {boolean} editable True if editable.
 */
Blockly.Block.prototype.setEditable = function(editable) {
  this.editable_ = editable;
  for (var i = 0, input; input = this.inputList[i]; i++) {
    for (var j = 0, field; field = input.fieldRow[j]; j++) {
      field.updateEditable();
    }
  }
  if (this.rendered) {
    var icons = this.getIcons();
    for (var i = 0; i < icons.length; i++) {
      icons[i].updateEditable();
    }
  }
};

/**
 * Set whether the connections are hidden (not tracked in a database) or not.
 * Recursively walk down all child blocks (except collapsed blocks).
 * @param {boolean} hidden True if connections are hidden.
 */
Blockly.Block.prototype.setConnectionsHidden = function(hidden) {
  if (!hidden && this.isCollapsed()) {
    if (this.outputConnection) {
      this.outputConnection.setHidden(hidden);
    }
    if (this.previousConnection) {
      this.previousConnection.setHidden(hidden);
    }
    if (this.nextConnection) {
      this.nextConnection.setHidden(hidden);
      var child = this.nextConnection.targetBlock();
      if (child) {
        child.setConnectionsHidden(hidden);
      }
    }
  } else {
    var myConnections = this.getConnections_(true);
    for (var i = 0, connection; connection = myConnections[i]; i++) {
      connection.setHidden(hidden);
      if (connection.isSuperior()) {
        var child = connection.targetBlock();
        if (child) {
          child.setConnectionsHidden(hidden);
        }
      }
    }
  }
};

/**
 * Set the URL of this block's help page.
 * @param {string|Function} url URL string for block help, or function that
 *     returns a URL.  Null for no help.
 */
Blockly.Block.prototype.setHelpUrl = function(url) {
  this.helpUrl = url;
};

/**
 * Change the tooltip text for a block.
 * @param {string|!Function} newTip Text for tooltip or a parent element to
 *     link to for its tooltip.  May be a function that returns a string.
 */
Blockly.Block.prototype.setTooltip = function(newTip) {
  this.tooltip = newTip;
};

/**
 * Get the colour of a block.
 * @return {number} HSV hue value.
 */
Blockly.Block.prototype.getColour = function() {
  return this.colourHue_;
};

/**
 * Change the colour of a block.
 * @param {number} colourHue HSV hue value.
 */
Blockly.Block.prototype.setColour = function(colourHue) {
  this.colourHue_ = colourHue;
  if (this.rendered) {
    this.updateColour();
  }
};

/**
 * Returns the named field from a block.
 * @param {string} name The name of the field.
 * @return {Blockly.Field} Named field, or null if field does not exist.
 * @private
 */
Blockly.Block.prototype.getField_ = function(name) {
  for (var i = 0, input; input = this.inputList[i]; i++) {
    for (var j = 0, field; field = input.fieldRow[j]; j++) {
      if (field.name === name) {
        return field;
      }
    }
  }
  return null;
};

/**
 * Returns the language-neutral value from the field of a block.
 * @param {string} name The name of the field.
 * @return {?string} Value from the field or null if field does not exist.
 */
Blockly.Block.prototype.getFieldValue = function(name) {
  var field = this.getField_(name);
  if (field) {
    return field.getValue();
  }
  return null;
};

/**
 * Returns the language-neutral value from the field of a block.
 * @param {string} name The name of the field.
 * @return {?string} Value from the field or null if field does not exist.
 * @deprecated December 2013
 */
Blockly.Block.prototype.getTitleValue = function(name) {
  console.warn('Deprecated call to getTitleValue, use getFieldValue instead.');
  return this.getFieldValue(name);
};

/**
 * Change the field value for a block (e.g. 'CHOOSE' or 'REMOVE').
 * @param {string} newValue Value to be the new field.
 * @param {string} name The name of the field.
 */
Blockly.Block.prototype.setFieldValue = function(newValue, name) {
  var field = this.getField_(name);
  goog.asserts.assertObject(field, 'Field "%s" not found.', name);
  field.setValue(newValue);
};

/**
 * Change the field value for a block (e.g. 'CHOOSE' or 'REMOVE').
 * @param {string} newValue Value to be the new field.
 * @param {string} name The name of the field.
 * @deprecated December 2013
 */
Blockly.Block.prototype.setTitleValue = function(newValue, name) {
  console.warn('Deprecated call to setTitleValue, use setFieldValue instead.');
  this.setFieldValue(newValue, name);
};

/**
 * Set whether this block can chain onto the bottom of another block.
 * @param {boolean} newBoolean True if there can be a previous statement.
 * @param {string|Array.<string>|null} opt_check Statement type or list of
 *     statement types.  Null or undefined if any type could be connected.
 */
Blockly.Block.prototype.setPreviousStatement = function(newBoolean, opt_check) {
  if (this.previousConnection) {
    goog.asserts.assert(!this.previousConnection.targetConnection,
        'Must disconnect previous statement before removing connection.');
    this.previousConnection.dispose();
    this.previousConnection = null;
  }
  if (newBoolean) {
    goog.asserts.assert(!this.outputConnection,
        'Remove output connection prior to adding previous connection.');
    if (opt_check === undefined) {
      opt_check = null;
    }
    this.previousConnection =
        new Blockly.Connection(this, Blockly.PREVIOUS_STATEMENT);
    this.previousConnection.setCheck(opt_check);
  }
  if (this.rendered) {
    this.render();
    this.bumpNeighbours_();
  }
};

/**
 * Set whether another block can chain onto the bottom of this block.
 * @param {boolean} newBoolean True if there can be a next statement.
 * @param {string|Array.<string>|null} opt_check Statement type or list of
 *     statement types.  Null or undefined if any type could be connected.
 */
Blockly.Block.prototype.setNextStatement = function(newBoolean, opt_check) {
  if (this.nextConnection) {
    goog.asserts.assert(!this.nextConnection.targetConnection,
        'Must disconnect next statement before removing connection.');
    this.nextConnection.dispose();
    this.nextConnection = null;
  }
  if (newBoolean) {
    if (opt_check === undefined) {
      opt_check = null;
    }
    this.nextConnection =
        new Blockly.Connection(this, Blockly.NEXT_STATEMENT);
    this.nextConnection.setCheck(opt_check);
  }
  if (this.rendered) {
    this.render();
    this.bumpNeighbours_();
  }
};

/**
 * Set whether this block returns a value.
 * @param {boolean} newBoolean True if there is an output.
 * @param {string|Array.<string>|null} opt_check Returned type or list of
 *     returned types.  Null or undefined if any type could be returned
 *     (e.g. variable get).
 */
Blockly.Block.prototype.setOutput = function(newBoolean, opt_check) {
  if (this.outputConnection) {
    goog.asserts.assert(!this.outputConnection.targetConnection,
        'Must disconnect output value before removing connection.');
    this.outputConnection.dispose();
    this.outputConnection = null;
  }
  if (newBoolean) {
    goog.asserts.assert(!this.previousConnection,
        'Remove previous connection prior to adding output connection.');
    if (opt_check === undefined) {
      opt_check = null;
    }
    this.outputConnection =
        new Blockly.Connection(this, Blockly.OUTPUT_VALUE);
    this.outputConnection.setCheck(opt_check);
  }
  if (this.rendered) {
    this.render();
    this.bumpNeighbours_();
  }
};

/**
 * Change the output type on a block.
 * @param {string|Array.<string>|null} check Returned type or list of
 *     returned types.  Null or undefined if any type could be returned
 *     (e.g. variable get).  It is fine if this is the same as the old type.
 * @throws {goog.asserts.AssertionError} if the block did not already have an
 *     output.
 */
Blockly.Block.prototype.changeOutput = function(check) {
  goog.asserts.assert(this.outputConnection,
      'Only use changeOutput() on blocks that already have an output.');
  this.outputConnection.setCheck(check);
};

/**
 * Set whether value inputs are arranged horizontally or vertically.
 * @param {boolean} newBoolean True if inputs are horizontal.
 */
Blockly.Block.prototype.setInputsInline = function(newBoolean) {
  this.inputsInline = newBoolean;
  if (this.rendered) {
    this.render();
    this.bumpNeighbours_();
    this.workspace.fireChangeEvent();
  }
};

/**
 * Set whether the block is disabled or not.
 * @param {boolean} disabled True if disabled.
 */
Blockly.Block.prototype.setDisabled = function(disabled) {
  this.disabled = disabled;
};

/**
 * Get whether the block is disabled or not due to parents.
 * The block's own disabled property is not considered.
 * @return {boolean} True if disabled.
 */
Blockly.Block.prototype.getInheritedDisabled = function() {
  var block = this;
  while (true) {
    block = block.getSurroundParent();
    if (!block) {
      // Ran off the top.
      return false;
    } else if (block.disabled) {
      return true;
    }
  }
};

/**
 * Get whether the block is collapsed or not.
 * @return {boolean} True if collapsed.
 */
Blockly.Block.prototype.isCollapsed = function() {
  return this.collapsed_;
};

/**
 * Set whether the block is collapsed or not.
 * @param {boolean} collapsed True if collapsed.
 */
Blockly.Block.prototype.setCollapsed = function(collapsed) {
  this.collapsed_ = collapsed;
};

/**
 * Create a human-readable text representation of this block and any children.
 * @param {?number} opt_maxLength Truncate the string to this length.
 * @return {string} Text of block.
 */
Blockly.Block.prototype.toString = function(opt_maxLength) {
  var text = [];
  if (this.collapsed_) {
    text.push(this.getInput('_TEMP_COLLAPSED_INPUT').fieldRow[0].text_);
  } else {
    for (var i = 0, input; input = this.inputList[i]; i++) {
      for (var j = 0, field; field = input.fieldRow[j]; j++) {
        text.push(field.getText());
      }
      if (input.connection) {
        var child = input.connection.targetBlock();
        if (child) {
          text.push(child.toString());
        } else {
          text.push('?');
        }
      }
    }
  }
  text = goog.string.trim(text.join(' ')) || '???';
  if (opt_maxLength) {
    // TODO: Improve truncation so that text from this block is given priority.
    // TODO: Handle FieldImage better.
    text = goog.string.truncate(text, opt_maxLength);
  }
  return text;
};

/**
 * Shortcut for appending a value input row.
 * @param {string} name Language-neutral identifier which may used to find this
 *     input again.  Should be unique to this block.
 * @return {!Blockly.Input} The input object created.
 */
Blockly.Block.prototype.appendValueInput = function(name) {
  return this.appendInput_(Blockly.INPUT_VALUE, name);
};

/**
 * Shortcut for appending a statement input row.
 * @param {string} name Language-neutral identifier which may used to find this
 *     input again.  Should be unique to this block.
 * @return {!Blockly.Input} The input object created.
 */
Blockly.Block.prototype.appendStatementInput = function(name) {
  return this.appendInput_(Blockly.NEXT_STATEMENT, name);
};

/**
 * Shortcut for appending a dummy input row.
 * @param {string} opt_name Language-neutral identifier which may used to find
 *     this input again.  Should be unique to this block.
 * @return {!Blockly.Input} The input object created.
 */
Blockly.Block.prototype.appendDummyInput = function(opt_name) {
  return this.appendInput_(Blockly.DUMMY_INPUT, opt_name || '');
};

/**
 * Interpolate a message string, creating fields and inputs.
 * @param {string} msg The message string to parse.  %1, %2, etc. are symbols
 *     for value inputs or for Fields, such as an instance of
 *     Blockly.FieldDropdown, which would be placed as a field in either the
 *     following value input or a dummy input.  The newline character forces
 *     the creation of an unnamed dummy input if any fields need placement.
 *     Note that '%10' would be interpreted as a reference to the tenth
 *     argument.  To show the first argument followed by a zero, use '%1 0'.
 *     (Spaces around tokens are stripped.)  To display a percentage sign
 *     followed by a number (e.g., "%123"), put that text in a
 *     Blockly.FieldLabel (as described below).
 * @param {!Array.<?string|number|Array.<string>|Blockly.Field>|number} var_args
 *     A series of tuples that each specify the value inputs to create.  Each
 *     tuple has at least two elements.  The first is its name; the second is
 *     its type, which can be any of:
 *     - A string (such as 'Number'), denoting the one type allowed in the
 *       corresponding socket.
 *     - An array of strings (such as ['Number', 'List']), denoting the
 *       different types allowed in the corresponding socket.
 *     - null, denoting that any type is allowed in the corresponding socket.
 *     - Blockly.Field, in which case that field instance, such as an
 *       instance of Blockly.FieldDropdown, appears (instead of a socket).
 *     If the type is any of the first three options (which are legal arguments
 *     to setCheck()), there should be a third element in the tuple, giving its
 *     alignment.
 *     The final parameter is not a tuple, but just an alignment for any
 *     trailing dummy inputs.  This last parameter is mandatory; there may be
 *     any number of tuples (though the number of tuples must match the symbols
 *     in msg).
 */
Blockly.Block.prototype.interpolateMsg = function(msg, var_args) {
  /**
   * Add a field to this input.
   * @this !Blockly.Input
   * @param {Blockly.Field|Array.<string|Blockly.Field>} field
   *     This is either a Field or a tuple of a name and a Field.
   */
  function addFieldToInput(field) {
    if (field instanceof Blockly.Field) {
      this.appendField(field);
    } else {
      goog.asserts.assert(goog.isArray(field));
      this.appendField(field[1], field[0]);
    }
  }

  // Validate the msg at the start and the dummy alignment at the end,
  // and remove the latter.
  goog.asserts.assertString(msg);
  var dummyAlign = arguments[arguments.length - 1];
  goog.asserts.assert(
      dummyAlign === Blockly.ALIGN_LEFT ||
      dummyAlign === Blockly.ALIGN_CENTRE ||
      dummyAlign === Blockly.ALIGN_RIGHT,
      'Illegal final argument "%d" is not an alignment.', dummyAlign);
  arguments.length = arguments.length - 1;

  var tokens = msg.split(this.interpolateMsg.SPLIT_REGEX_);
  var fields = [];
  for (var i = 0; i < tokens.length; i += 2) {
    var text = goog.string.trim(tokens[i]);
    var input = undefined;
    if (text) {
      fields.push(new Blockly.FieldLabel(text));
    }
    var symbol = tokens[i + 1];
    if (symbol && symbol.charAt(0) == '%') {
      // Numeric field.
      var number = parseInt(symbol.substring(1), 10);
      var tuple = arguments[number];
      goog.asserts.assertArray(tuple,
          'Message symbol "%s" is out of range.', symbol);
      goog.asserts.assertArray(tuple,
          'Argument "%s" is not a tuple.', symbol);
      if (tuple[1] instanceof Blockly.Field) {
        fields.push([tuple[0], tuple[1]]);
      } else {
        input = this.appendValueInput(tuple[0])
            .setCheck(tuple[1])
            .setAlign(tuple[2]);
      }
      arguments[number] = null;  // Inputs may not be reused.
    } else if (symbol == '\n' && fields.length) {
      // Create a dummy input.
      input = this.appendDummyInput();
    }
    // If we just added an input, hang any pending fields on it.
    if (input && fields.length) {
      fields.forEach(addFieldToInput, input);
      fields = [];
    }
  }
  // If any fields remain, create a trailing dummy input.
  if (fields.length) {
    var input = this.appendDummyInput()
        .setAlign(dummyAlign);
    fields.forEach(addFieldToInput, input);
  }

  // Verify that all inputs were used.
  for (var i = 1; i < arguments.length - 1; i++) {
    goog.asserts.assert(arguments[i] === null,
        'Input "%%s" not used in message: "%s"', i, msg);
  }
  // Make the inputs inline unless there is only one input and
  // no text follows it.
  this.setInputsInline(!msg.match(this.interpolateMsg.INLINE_REGEX_));
};

Blockly.Block.prototype.interpolateMsg.SPLIT_REGEX_ = /(%\d+|\n)/;
Blockly.Block.prototype.interpolateMsg.INLINE_REGEX_ = /%1\s*$/;


/**
 * Add a value input, statement input or local variable to this block.
 * @param {number} type Either Blockly.INPUT_VALUE or Blockly.NEXT_STATEMENT or
 *     Blockly.DUMMY_INPUT.
 * @param {string} name Language-neutral identifier which may used to find this
 *     input again.  Should be unique to this block.
 * @return {!Blockly.Input} The input object created.
 * @private
 */
Blockly.Block.prototype.appendInput_ = function(type, name) {
  var connection = null;
  if (type == Blockly.INPUT_VALUE || type == Blockly.NEXT_STATEMENT) {
    connection = new Blockly.Connection(this, type);
  }
  var input = new Blockly.Input(type, name, this, connection);
  // Append input to list.
  this.inputList.push(input);
  if (this.rendered) {
    this.render();
    // Adding an input will cause the block to change shape.
    this.bumpNeighbours_();
  }
  return input;
};

/**
 * Move a named input to a different location on this block.
 * @param {string} name The name of the input to move.
 * @param {?string} refName Name of input that should be after the moved input,
 *   or null to be the input at the end.
 */
Blockly.Block.prototype.moveInputBefore = function(name, refName) {
  if (name == refName) {
    return;
  }
  // Find both inputs.
  var inputIndex = -1;
  var refIndex = refName ? -1 : this.inputList.length;
  for (var i = 0, input; input = this.inputList[i]; i++) {
    if (input.name == name) {
      inputIndex = i;
      if (refIndex != -1) {
        break;
      }
    } else if (refName && input.name == refName) {
      refIndex = i;
      if (inputIndex != -1) {
        break;
      }
    }
  }
  goog.asserts.assert(inputIndex != -1, 'Named input "%s" not found.', name);
  goog.asserts.assert(refIndex != -1, 'Reference input "%s" not found.',
                      refName);
  this.moveNumberedInputBefore(inputIndex, refIndex);
};

/**
 * Move a numbered input to a different location on this block.
 * @param {number} inputIndex Index of the input to move.
 * @param {number} refIndex Index of input that should be after the moved input.
 */
Blockly.Block.prototype.moveNumberedInputBefore = function(
    inputIndex, refIndex) {
  // Validate arguments.
  goog.asserts.assert(inputIndex != refIndex, 'Can\'t move input to itself.');
  goog.asserts.assert(inputIndex < this.inputList.length,
                      'Input index ' + inputIndex + ' out of bounds.');
  goog.asserts.assert(refIndex <= this.inputList.length,
                      'Reference input ' + refIndex + ' out of bounds.');
  // Remove input.
  var input = this.inputList[inputIndex];
  this.inputList.splice(inputIndex, 1);
  if (inputIndex < refIndex) {
    refIndex--;
  }
  // Reinsert input.
  this.inputList.splice(refIndex, 0, input);
  if (this.rendered) {
    this.render();
    // Moving an input will cause the block to change shape.
    this.bumpNeighbours_();
  }
};

/**
 * Remove an input from this block.
 * @param {string} name The name of the input.
 * @param {boolean} opt_quiet True to prevent error if input is not present.
 * @throws {goog.asserts.AssertionError} if the input is not present and
 *     opt_quiet is not true.
 */
Blockly.Block.prototype.removeInput = function(name, opt_quiet) {
  for (var i = 0, input; input = this.inputList[i]; i++) {
    if (input.name == name) {
      if (input.connection && input.connection.targetConnection) {
        // Disconnect any attached block.
        input.connection.targetBlock().setParent(null);
      }
      input.dispose();
      this.inputList.splice(i, 1);
      if (this.rendered) {
        this.render();
        // Removing an input will cause the block to change shape.
        this.bumpNeighbours_();
      }
      return;
    }
  }
  if (!opt_quiet) {
    goog.asserts.fail('Input "%s" not found.', name);
  }
};

/**
 * Fetches the named input object.
 * @param {string} name The name of the input.
 * @return {Object} The input object, or null of the input does not exist.
 */
Blockly.Block.prototype.getInput = function(name) {
  for (var i = 0, input; input = this.inputList[i]; i++) {
    if (input.name == name) {
      return input;
    }
  }
  // This input does not exist.
  return null;
};

/**
 * Fetches the block attached to the named input.
 * @param {string} name The name of the input.
 * @return {Blockly.Block} The attached value block, or null if the input is
 *     either disconnected or if the input does not exist.
 */
Blockly.Block.prototype.getInputTargetBlock = function(name) {
  var input = this.getInput(name);
  return input && input.connection && input.connection.targetBlock();
};

/**
 * Returns the comment on this block (or '' if none).
 * @return {string} Block's comment.
 */
Blockly.Block.prototype.getCommentText = function() {
  return this.comment || '';
};

/**
 * Set this block's comment text.
 * @param {?string} text The text, or null to delete.
 */
Blockly.Block.prototype.setCommentText = function(text) {
  this.comment = text;
};

/**
 * Set this block's warning text.
 * @param {?string} text The text, or null to delete.
 */
Blockly.Block.prototype.setWarningText = function(text) {
  // NOP.
};

/**
 * Give this block a mutator dialog.
 * @param {Blockly.Mutator} mutator A mutator dialog instance or null to remove.
 */
Blockly.Block.prototype.setMutator = function(mutator) {
  // NOP.
};

/**
 * Return the coordinates of the top-left corner of this block relative to the
 * drawing surface's origin (0,0).
 * @return {!goog.math.Coordinate} Object with .x and .y properties.
 */
Blockly.Block.prototype.getRelativeToSurfaceXY = function() {
  return this.xy_;
};

/**
 * Move a block by a relative offset.
 * @param {number} dx Horizontal offset.
 * @param {number} dy Vertical offset.
 */
Blockly.Block.prototype.moveBy = function(dx, dy) {
  this.xy_.translate(dx, dy);
};

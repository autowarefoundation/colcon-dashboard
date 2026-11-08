import { App } from './state.js';

/* The layout modes (layered / force / 3d) implement one interface, and
   the implementing module registers itself. Every method is optional -
   call through mode().x?.():
     activate()        the mode was just selected
     deactivate()      another mode was selected
     show() / hide()   the graph panel appeared / went away
     onLayout()        buildGraphView produced a fresh layout
     onState()         a state poll landed
     fit()             frame everything
     followFrontier()  frame the packages that build now
     focusPkg(name)    fly to one package; absent: the SVG camera handles it
     resize()          the canvas size changed
     onViewBox(vb)     the SVG camera moved to the view box vb
     restoreView()     the first layout of the page: show the view from
                       before a reload; false when there is none */

const modes = {};

export function registerMode(name, impl) {
  modes[name] = impl;
}

export function mode() {
  return modes[App.layoutMode] || modes.layered;
}

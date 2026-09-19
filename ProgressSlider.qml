import QtQuick
import qs.Commons
import qs.Ui

Item {
  id: root

  property QtObject bar: null
  property real value: 0
  property real minimum: 0
  property real maximum: 1
  property real step: 0.05
  property bool dragging: false
  property real liveValue: value
  property real trackHeight: Math.max(4, Math.round(Style.spacing.controlHeight * 0.11))
  property real knobSize: Math.max(14, Math.round(Style.spacing.controlHeight * 0.38))

  signal moved(real value)
  signal released(real value)

  implicitWidth: Style.space(200)
  implicitHeight: Math.max(Style.space(22), knobSize + Style.spacing.md)

  readonly property real range: Math.max(0.0001, maximum - minimum)
  readonly property real progress: Math.max(0, Math.min(1, (liveValue - minimum) / range))
  readonly property bool hot: drag.active || wheelHover.containsMouse

  onValueChanged: if (!root.dragging) liveValue = value

  function valueFromX(x) {
    var w = Math.max(1, width)
    var raw = root.minimum + (Math.max(0, Math.min(w, x)) / w) * root.range
    return Math.max(root.minimum, Math.min(root.maximum, raw))
  }

  function applyX(x) {
    root.liveValue = root.valueFromX(x)
    root.moved(root.liveValue)
  }

  Rectangle {
    id: track
    anchors.verticalCenter: parent.verticalCenter
    anchors.left: parent.left
    anchors.right: parent.right
    height: root.trackHeight
    radius: height / 2
    color: root.bar ? Style.selectedFillFor(root.bar.foreground, Color.accent) : "#333"
  }

  Rectangle {
    anchors.verticalCenter: track.verticalCenter
    anchors.left: track.left
    height: track.height
    radius: track.radius
    color: root.bar ? root.bar.foreground : "#eee"
    width: track.width * root.progress
  }

  Rectangle {
    width: root.knobSize
    height: root.knobSize
    radius: root.knobSize / 2
    color: root.bar ? root.bar.foreground : "#eee"
    anchors.verticalCenter: track.verticalCenter
    x: Math.max(0, Math.min(track.width - width, track.width * root.progress - width / 2))
    scale: root.hot ? 1.15 : 1.0
  }

  MouseArea {
    id: wheelHover
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.NoButton
    cursorShape: Qt.PointingHandCursor
  }

  DragHandler {
    id: drag
    target: null
    acceptedButtons: Qt.LeftButton
    grabPermissions: PointerHandler.CanTakeOverFromAnything
    onActiveChanged: {
      root.dragging = active
      if (active) root.applyX(centroid.position.x)
      else root.released(root.liveValue)
    }
    onCentroidChanged: if (active) root.applyX(centroid.position.x)
  }

  WheelHandler {
    acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
    onWheel: function(event) {
      event.accepted = true
      var delta = event.angleDelta.y > 0 ? root.step : -root.step
      root.liveValue = Math.max(root.minimum, Math.min(root.maximum, root.liveValue + delta))
      root.released(root.liveValue)
    }
  }
}

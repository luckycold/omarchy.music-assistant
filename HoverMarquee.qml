import QtQuick
import qs.Commons

Item {
  id: root

  property string text: ""
  property color color: "white"
  property string fontFamily: ""
  property int fontPixelSize: 12
  property bool fontBold: false
  property bool hovered: false

  readonly property bool scrolling: root.hovered && full.implicitWidth > root.width
  readonly property int gap: Math.max(40, root.fontPixelSize * 3)
  readonly property int shift: full.implicitWidth + root.gap

  clip: true
  implicitHeight: label.implicitHeight
  visible: root.text !== ""

  Text {
    id: full
    visible: false
    textFormat: Text.PlainText
    text: root.text
    font.family: root.fontFamily
    font.pixelSize: root.fontPixelSize
    font.bold: root.fontBold
  }

  Row {
    id: ticker
    spacing: root.gap
    y: Math.max(0, (root.height - label.implicitHeight) / 2)

    Text {
      id: label
      textFormat: Text.PlainText
      text: root.text
      color: root.color
      font.family: root.fontFamily
      font.pixelSize: root.fontPixelSize
      font.bold: root.fontBold
      elide: root.scrolling ? Text.ElideNone : Text.ElideRight
      width: root.scrolling ? implicitWidth : root.width
    }

    Text {
      id: copy
      visible: root.scrolling
      textFormat: Text.PlainText
      text: root.text
      color: root.color
      font.family: root.fontFamily
      font.pixelSize: root.fontPixelSize
      font.bold: root.fontBold
    }
  }

  SequentialAnimation {
    running: root.hovered && full.implicitWidth > root.width
    loops: Animation.Infinite
    PauseAnimation { duration: 700 }
    NumberAnimation {
      target: ticker
      property: "x"
      from: 0
      to: -root.shift
      duration: Math.max(2500, root.shift * 18)
      easing.type: Easing.Linear
    }
    ScriptAction { script: ticker.x = 0 }
    onRunningChanged: if (!running) ticker.x = 0
  }
}

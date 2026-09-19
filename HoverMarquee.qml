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

  Text {
    id: label
    textFormat: Text.PlainText
    text: root.text
    color: root.color
    font.family: root.fontFamily
    font.pixelSize: root.fontPixelSize
    font.bold: root.fontBold
    elide: scrolling ? Text.ElideNone : Text.ElideRight
    width: scrolling ? full.implicitWidth : root.width
    y: Math.max(0, (root.height - implicitHeight) / 2)

    readonly property bool scrolling: root.hovered && full.implicitWidth > root.width

    NumberAnimation on x {
      running: root.hovered && full.implicitWidth > root.width
      from: 0
      to: root.width - full.implicitWidth
      duration: Math.max(2500, (full.implicitWidth - root.width) * 28)
      loops: Animation.Infinite
      easing.type: Easing.Linear
      onRunningChanged: if (!running) label.x = 0
    }
  }
}

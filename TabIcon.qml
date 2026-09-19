import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

BorderSurface {
  id: root

  property string icon: ""
  property string label: ""
  property string labelId: ""
  property int count: 0
  property bool active: false
  property QtObject bar: null

  signal clicked()

  width: Style.space(36)
  height: Style.space(36)
  radius: Style.spacing.labelGap
  color: active
    ? Style.selectedFillFor(bar.foreground, Color.accent)
    : "transparent"
  borderSpec: active
    ? Border.controlSpec("normal", bar.foreground, Color.accent)
    : Border.none()

  Column {
    anchors.centerIn: parent
    spacing: 1
    Text {
      textFormat: Text.PlainText
      text: root.icon
      color: root.bar.foreground
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.body
      anchors.horizontalCenter: parent.horizontalCenter
      opacity: root.active ? 1.0 : 0.8
    }
    Text {
      textFormat: Text.PlainText
      text: root.count > 0 ? root.label + " " + root.count : root.label
      color: root.bar.foreground
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.caption
      anchors.horizontalCenter: parent.horizontalCenter
      opacity: root.active ? 1.0 : 0.7
    }
  }

  MouseArea {
    anchors.fill: parent
    cursorShape: Qt.PointingHandCursor
    hoverEnabled: true
    onClicked: root.clicked()
  }
}

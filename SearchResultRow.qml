import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

BorderSurface {
  id: root

  property string imageUrl: ""
  property string title: ""
  property string subtitle: ""
  property string type: ""
  property string source: ""
  property bool showTypeBadge: true
  property bool showSourceBadge: true
  property QtObject bar: null
  property bool active: false

  signal clicked()
  signal contextMenu(var mouse)

  width: parent ? parent.width : 0
  height: row.implicitHeight + Style.space(8)
  radius: Style.spacing.labelGap
  color: root.active
    ? Style.selectedFillFor(root.bar.foreground, Color.accent)
    : "transparent"
  borderSpec: root.active
    ? Border.controlSpec("normal", root.bar.foreground, Color.accent)
    : Border.none()

  Row {
    id: row
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(8)
    anchors.rightMargin: Style.space(8)
    spacing: Style.space(8)

    Image {
      source: root.imageUrl
      width: Style.space(28)
      height: Style.space(28)
      fillMode: Image.PreserveAspectCrop
      visible: source !== ""
      asynchronous: true
      anchors.verticalCenter: parent.verticalCenter
    }

    Item {
      width: parent.width - Style.space(36)
      height: titleMarquee.implicitHeight
      anchors.verticalCenter: parent.verticalCenter

      HoverMarquee {
        id: titleMarquee
        anchors.left: parent.left
        anchors.right: badges.left
        anchors.rightMargin: Style.space(6)
        height: implicitHeight
        anchors.verticalCenter: parent.verticalCenter
        text: root.title || "?"
        color: root.bar.foreground
        fontFamily: root.bar.fontFamily
        fontPixelSize: Style.font.bodySmall
        fontBold: true
        hovered: rowHover.containsMouse
      }

      Row {
        id: badges
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(3)

        Rectangle {
          visible: root.showTypeBadge && root.type !== ""
          radius: 3
          color: Style.normalFillFor(root.bar.foreground, Color.accent)
          border.color: Border.color(Border.controlSpec("normal", root.bar.foreground, Color.accent))
          border.width: 1
          implicitWidth: typeLbl.implicitWidth + Style.space(8)
          implicitHeight: typeLbl.implicitHeight + Style.space(4)
          Text {
            textFormat: Text.PlainText
            id: typeLbl
            anchors.centerIn: parent
            text: root.type
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        Rectangle {
          visible: root.showSourceBadge && root.source !== ""
          radius: 3
          color: "transparent"
          border.color: Qt.darker(root.bar.foreground, 1.3)
          border.width: 1
          implicitWidth: srcLbl.implicitWidth + Style.space(8)
          implicitHeight: srcLbl.implicitHeight + Style.space(4)
          Text {
            textFormat: Text.PlainText
            id: srcLbl
            anchors.centerIn: parent
            text: root.source
            color: Qt.darker(root.bar.foreground, 1.2)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }

  HoverMarquee {
    visible: root.subtitle !== ""
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: row.bottom
    anchors.leftMargin: Style.space(36)
    anchors.rightMargin: Style.space(8)
    anchors.topMargin: Style.space(-2)
    text: root.subtitle
    color: Qt.darker(root.bar.foreground, 1.4)
    fontFamily: root.bar.fontFamily
    fontPixelSize: Style.font.caption
    hovered: rowHover.containsMouse
  }

  MouseArea {
    id: rowHover
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    onClicked: function(mouse) {
      if (mouse.button === Qt.RightButton) root.contextMenu(mouse)
      else root.clicked()
    }
  }
}

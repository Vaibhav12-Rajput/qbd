const xml2js = require('xml2js');


exports.convertXmlToJson = (xmlString) => {
    let jsonData = null;
    const parser = new xml2js.Parser({ explicitArray: false });

    parser.parseString(xmlString, (err, result) => {
        if (err) {
            console.error('Error parsing XML:', err);
            return;
        }
        jsonData = result;
    });
    return jsonData;
}

exports.jsonToXml = (jsonData) => {
    const builder = new xml2js.Builder({
        xmldec: {

        }
    });

    const xmlData = builder.buildObject(jsonData);

    return xmlData.replace('<?xml version="1.0"?>', '<?qbxml version="13.0"?>');

}